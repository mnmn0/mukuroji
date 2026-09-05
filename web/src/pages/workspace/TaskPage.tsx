import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
  CuratedContextSourceKind,
  ResolvedWorkItemConfiguration,
  TaskViewScope,
  WorkItemDependencyEndpoint,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { canMutateWorkspaceContent } from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../../auth/session'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  type FileArtifactScope,
  useFileArtifacts,
} from '../../files/mutations/useFileArtifacts'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  applyBulkOperation,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from '../../bulk-operations/api'
import {
  getProjectUsers,
  isActiveProjectAssignmentCandidate,
  type ProjectMember,
  type ProjectMemberRole,
  type ProjectUser,
  type UpdateProjectMemberInput,
  removeProjectMember,
  updateProjectMember,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import {
  usePlanningProjectRoles,
  useProjectMembers,
  useProjectUsers,
} from '../../projects/queries/useProjectMembers'
import {
  createTeamIssue,
  TeamIssuesApiError,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../../issues/api'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import {
  canManagePlanningWorkItemDependencyEndpoint,
  createPlanningAccessSnapshot,
} from '../../planning/model/permissions'
import {
  useProjectIssues,
  useTeamIssueDetail,
  useTeamIssues,
} from '../../issues/queries/useWorkItems'
import { useProjectCustomerImpact } from '../../customers/queries/useCustomers'
import { useIssueCollaboration } from '../../issues/mutations/useIssueCollaboration'
import {
  applyIssueCollaborationTabToSearchParams,
  applyIssueCollaborationSourceToSearchParams,
  issueCollaborationTargetSearchParams,
  resolveIssueCollaborationTab,
  type IssueCollaborationRoute,
  type IssueCollaborationTab,
} from '../../issues/model/collaborationTabs'
import { readIssueSourceKind } from '../../issues/model/contextSources'
import {
  createProjectIssuesPath,
} from '../../shared/routing/paths'
import { useReportWorkspaceSidebarRouteState } from '../../shared/ui/sidebar'
import {
  type CreateWorkItemInput,
  type CanonicalWorkItem,
} from '../../tasks/api'
import {
  createProjectUsersPageKey,
  mergeProjectUsers,
  resolveCurrentUserProjectKey,
  resolveProjectTaskRouteContext,
} from '../../tasks/model/taskRoute'
import { createTaskScheduleMutationController } from '../../tasks/mutations/createTaskScheduleMutationController'
import { applyTaskPatchOptimistically, type TaskCreateContext } from '../../tasks/model/taskView'
import { TaskScreen } from '../../tasks/ui/TaskScreen'
import {
  createBuiltInTaskViewDefinition,
  filterTaskViewAudienceTeams,
  presentationSettingsToTaskViewDefinition,
  projectStateToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
  taskViewDefinitionToProjectState,
} from '../../task-views/model/taskViewSurfaceState'
import { preserveTaskViewUrlState } from '../../task-views/model/taskViewUrlState'
import { useTaskViewController } from '../../task-views/mutations/useTaskViewController'
import { TaskViewToolbar } from '../../task-views/ui/TaskViewToolbar'
import {
  createTaskViewOption,
  formatTaskViewMigrationWarning,
} from '../../task-views/ui/taskViewToolbarAdapter'
import { canWriteTaskViewWorkItem } from '../../task-views/model/taskViewWorkItemPermission'
import type { WorkspaceMember } from '../../workspace/api'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import {
  createWorkItemRelation,
  deleteWorkItemRelation,
} from '../../work-items/api'
import {
  useTeamWorkItemConfigurations,
} from '../../work-items/queries/useWorkItemConfigurations'
import {
  resolveConfiguredWorkflowStatuses,
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
  resolveWorkItemTypeWorkflowStatuses,
} from '../../work-items/model/workItemDisplay'
import type { WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'
import { aiAssistanceUiEnabled } from '../../features/ai-assistance/model/aiAssistanceRollout'
import { taskDetailAiAssistanceRenderer } from '../../features/ai-assistance/ui'

/** Aggregated resolved configuration result for every Team represented by a Project. */
type ProjectWorkItemConfigurationLoadResult = {
  /** Resolved Work Item configuration keyed by Team ID. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Session-policy-aware load errors retained for the route boundary. */
  errors: unknown[]
  /** Team IDs whose Work Item configuration could not be loaded. */
  failedTeamIds: string[]
}

const emptyProjectMembers: ProjectMember[] = []
const emptyProjectRoles: Readonly<Record<string, ProjectMemberRole>> = {}
const emptyProjectUsers: ProjectUser[] = []
const emptyTeamIssues: TeamIssue[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
const emptyResolvedWorkItemConfigurations: Record<string, ResolvedWorkItemConfiguration> = {}
const emptyConfigurationTeamIds: string[] = []
const emptyProjectWorkItemConfigurationLoadResult: ProjectWorkItemConfigurationLoadResult = {
  configurationsByTeam: emptyResolvedWorkItemConfigurations,
  errors: [],
  failedTeamIds: emptyConfigurationTeamIds,
}
const ambiguousIssueSelectionLocationState = 'ambiguous-issue-selection'
const standardTaskViewFields = [
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
 * Preserves the identity of a Work Item file scope until its route identifiers change.
 *
 * @param issueId - Selected Work Item identifier.
 * @param teamId - Team that owns the selected Work Item.
 * @returns A stable Work Item file scope, or undefined when the route is incomplete.
 */
function useWorkItemFileScope(issueId?: string, teamId?: string) {
  return useMemo<FileArtifactScope | undefined>(() =>
    issueId && teamId
      ? { issueId, kind: 'work-item', teamId }
      : undefined,
  [issueId, teamId])
}

/**
 * Preserves the identity of a Project file scope until its route identifiers change.
 *
 * @param projectId - Project identifier resolved from the route.
 * @param teamId - Team that owns the Project file collection.
 * @returns A stable Project file scope, or undefined when no Team is selected.
 */
function useProjectFileScope(projectId: string, teamId?: string) {
  return useMemo<FileArtifactScope | undefined>(() =>
    teamId ? { kind: 'project', projectId, teamId } : undefined,
  [projectId, teamId])
}

/**
 * Resolves the authenticated Project task route and composes the task feature screen.
 *
 * @returns The route-level task page with loading, error, and navigation boundaries.
 */
export function TaskPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const {
    hasQuickAccessLoadError,
    isAiAssistanceTaskEnabled,
    isProjectQuickAccess,
    isQuickAccessLoading,
    isQuickAccessSaving,
    onToggleProjectQuickAccess,
  } = useWorkspaceRouteContext()
  const [mutationRequestRunner] = useState(() => createMutationRequestRunner())
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = params.projectId ?? 'refero'
  const selectedTeamId = searchParams.get('teamId') ?? undefined
  const selectedIssueId = searchParams.get('issueId') ?? undefined
  const focusedCommentId = searchParams.get('commentId')?.trim() || undefined
  const focusedRootCommentId = searchParams.get('rootCommentId')?.trim() || undefined
  const focusedContextItemId = searchParams.get('contextItemId')?.trim() || undefined
  const focusedSourceId = searchParams.get('sourceId')?.trim() || undefined
  const focusedSourceKind: CuratedContextSourceKind | undefined =
    readIssueSourceKind(searchParams.get('sourceKind'))
  const focusedActivityEventId = searchParams.get('activityEventId')?.trim() || undefined
  const requestedCollaborationTab = searchParams.get('collaborationTab')
  const collaborationTab = resolveIssueCollaborationTab({
    requestedTab: requestedCollaborationTab,
    focusedContextItemId,
    focusedSourceId,
    focusedActivityEventId,
  })
  const isCreateTaskRequested = searchParams.get('create') === '1'
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [projectUserQuery, setProjectUserQuery] = useState('')
  const [projectUsersExtraPage, setProjectUsersExtraPage] = useState<{
    key: string
    nextToken?: string
    users: ProjectUser[]
  }>()
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
  const canAccessTriage = workspaceAccess?.currentMember.status === 'active' &&
    workspaceAccess.currentMember.role !== 'guest'
  const {
    data: projectIssues = emptyTeamIssues,
    error: taskError,
    isLoading: isProjectTasksLoading,
    mutate: mutateProjectTasks,
    canReadCustomerImpact,
  } = useProjectIssues(
    accessToken,
    projectId,
    Boolean(user && !currentUserError),
    true,
  )
  const {
    data: projectCustomerImpact,
    error: projectCustomerImpactError,
    key: projectCustomerImpactKey,
  } = useProjectCustomerImpact(
    accessToken,
    projectId,
    Boolean(user && !currentUserError && canAccessTriage && canReadCustomerImpact),
  )
  const {
    data: planningSnapshot,
    error: planningError,
    isLoading: isPlanningLoading,
    key: planningKey,
    mutate: mutatePlanning,
  } = usePlanningSnapshot(accessToken, Boolean(user && !currentUserError))
  const {
    data: teams = [],
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
    key: projectDirectoryKey,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const {
    data: projectMembersData,
    error: projectMembersError,
    isLoading: isProjectMembersLoading,
    mutate: mutateProjectMembers,
    key: projectMembersKey,
  } = useProjectMembers(
    accessToken,
    projectId,
    Boolean(user && !currentUserError),
  )
  const projectMembers = projectMembersData ?? emptyProjectMembers
  const activeProjectMembers = useMemo(
    () => projectMembers.filter(isActiveProjectAssignmentCandidate),
    [projectMembers],
  )
  const currentUserProjectKey = resolveCurrentUserProjectKey(user)
  const canMutateContent = canMutateWorkspaceContent(user)
  const planningProjectScopes = useMemo(
    () => teams.flatMap((team) => team.projects.map((project) => ({
      teamId: team.id,
      projectId: project.id,
    }))),
    [teams],
  )
  const {
    data: planningProjectRolesResult,
    error: planningProjectRolesError,
    isLoading: isPlanningProjectRolesLoading,
    key: planningProjectRolesKey,
    mutate: mutatePlanningProjectRoles,
  } = usePlanningProjectRoles(
    accessToken,
    currentUserProjectKey,
    planningProjectScopes,
    Boolean(user && !currentUserError && !user.isSystemAdmin && canMutateContent),
  )
  const planningProjectRoles = planningProjectRolesResult?.roles ?? emptyProjectRoles
  const planningAccess = useMemo(
    () => createPlanningAccessSnapshot(teams, planningProjectRoles),
    [planningProjectRoles, teams],
  )
  const canManageProjectMembers =
    canMutateContent && (
      Boolean(user?.isSystemAdmin) ||
      projectMembers.some((member) =>
        member.id === currentUserProjectKey && member.role === 'manager',
      )
    )
  const {
    data: projectUsersFirstPage,
    error: projectUsersError,
    isLoading: isProjectUsersLoading,
    key: projectUsersKey,
  } = useProjectUsers(
    accessToken,
    projectId,
    projectUserQuery,
    Boolean(user && !currentUserError && canManageProjectMembers),
  )
  const projectUsersPageKey = createProjectUsersPageKey(projectId, projectUserQuery)
  const activeProjectUsersExtraPage = projectUsersExtraPage?.key === projectUsersPageKey
    ? projectUsersExtraPage
    : undefined
  const projectUsers = useMemo(
    () => mergeProjectUsers(
      projectUsersFirstPage?.users ?? emptyProjectUsers,
      activeProjectUsersExtraPage?.users ?? emptyProjectUsers,
    ),
    [activeProjectUsersExtraPage?.users, projectUsersFirstPage?.users],
  )
  const projectUsersNextToken =
    activeProjectUsersExtraPage ? activeProjectUsersExtraPage.nextToken : projectUsersFirstPage?.nextToken
  const projectUsersErrorMessage = projectUsersError
    ? t('workspace.permissions.usersError')
    : undefined
  const {
    activeProject,
    activeTeam,
    configurationTeamIds,
    creationTeam,
    hasAmbiguousIssueSelection,
    interactionTeam,
    interactionTeamId,
    listConfigurationTeamId,
    resolvedSelectedIssue,
    selectedWorkItemTeamId,
    tasks,
  } = useMemo(
    () => resolveProjectTaskRouteContext({
      projectId,
      projectIssues,
      selectedIssueId,
      selectedTeamId,
      suppressIssueFallback:
        location.state === ambiguousIssueSelectionLocationState,
      teams,
    }),
    [
      location.state,
      projectId,
      projectIssues,
      selectedIssueId,
      selectedTeamId,
      teams,
    ],
  )
  const {
    data: workItemConfigurationLoadResult = emptyProjectWorkItemConfigurationLoadResult,
    error: workItemConfigurationError,
    isLoading: isWorkItemConfigurationLoading,
    mutate: mutateWorkItemConfigurations,
    key: workItemConfigurationKey,
  } = useTeamWorkItemConfigurations(
    accessToken,
    'project',
    configurationTeamIds,
    Boolean(user && !currentUserError),
  )
  const resolvedConfiguration = selectedWorkItemTeamId
    ? workItemConfigurationLoadResult.configurationsByTeam[selectedWorkItemTeamId]
    : undefined
  const failedConfigurationTeamIds = workItemConfigurationLoadResult.failedTeamIds
  const taskViewScope = useMemo<TaskViewScope>(
    () => selectedTeamId
      ? { kind: 'project', projectId, teamId: selectedTeamId }
      : { kind: 'project', projectId },
    [projectId, selectedTeamId],
  )
  const taskViewCustomFields = useMemo(() => {
    const fieldsById = new Map<string, string>()
    for (const resolved of Object.values(
      workItemConfigurationLoadResult.configurationsByTeam,
    )) {
      for (const field of resolved.configuration.customFields) {
        if (field.projectIds?.length && !field.projectIds.includes(projectId)) continue
        if (!fieldsById.has(field.id)) fieldsById.set(field.id, field.name)
      }
    }
    return [...fieldsById].map(([id, name]) => ({ id, name }))
  }, [projectId, workItemConfigurationLoadResult.configurationsByTeam])
  const taskViewWorkflowStatuses = useMemo(
    () => Object.entries(workItemConfigurationLoadResult.configurationsByTeam)
      .flatMap(([teamId, resolved]) =>
        resolveWorkItemTypeWorkflowStatuses(resolved.configuration).map(({
          status,
          workItemTypeId,
        }) => ({
          statusId: status.id,
          teamId,
          workItemTypeId,
        }))
      ),
    [workItemConfigurationLoadResult.configurationsByTeam],
  )
  const taskViewLegacyStatusIds = useMemo(
    () => [...new Set(Object.values(workItemConfigurationLoadResult.configurationsByTeam)
      .flatMap((resolved) =>
        resolveConfiguredWorkflowStatuses(resolved.configuration).map((status) => status.id)
      ))],
    [workItemConfigurationLoadResult.configurationsByTeam],
  )
  const taskViewFields = useMemo(
    () => [
      ...standardTaskViewFields,
      ...taskViewCustomFields.map((field) => `custom:${field.id}`),
    ],
    [taskViewCustomFields],
  )
  const taskViewColumns = useMemo(
    () => [
      ...standardTaskViewFields,
      ...(taskViewCustomFields.length > 0 ? ['customFields'] : []),
      ...taskViewCustomFields.map((field) => `custom:${field.id}`),
    ],
    [taskViewCustomFields],
  )
  const builtInTaskViewDefinition = useMemo(
    () => createBuiltInTaskViewDefinition(
      'project',
      taskViewScope,
      'table',
      taskViewCustomFields.length > 0 ? ['customFields'] : [],
    ),
    [taskViewCustomFields.length, taskViewScope],
  )
  const taskViewController = useTaskViewController({
    accessToken,
    builtInDefinition: builtInTaskViewDefinition,
    capabilities: {
      columns: taskViewColumns,
      fields: taskViewFields,
      layoutModes: ['table', 'board', 'gantt', 'calendar'],
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
    surface: 'project',
  })
  const taskViewFieldOptions = useMemo(
    () => [
      { id: 'title', label: t('tasks.create.title') },
      { id: 'status', label: t('tasks.filter.status') },
      { id: 'assignee', label: t('tasks.filter.assignee') },
      { id: 'dueDate', label: t('tasks.filter.dueDate') },
      { id: 'priority', label: t('tasks.filter.priority') },
      { id: 'workItemType', label: t('tasks.column.workItemType') },
      { id: 'project', label: t('workspace.column.project') },
      { id: 'team', label: t('workspace.column.team') },
      ...(taskViewCustomFields.length > 0
        ? [{ id: 'customFields', label: t('workItems.fields.title') }]
        : []),
      ...taskViewCustomFields.map((field) => ({
        id: `custom:${field.id}`,
        label: field.name,
      })),
    ],
    [t, taskViewCustomFields],
  )
  const taskViewGroupOptions = useMemo(
    () => taskViewFieldOptions.filter((option) => option.id !== 'customFields'),
    [taskViewFieldOptions],
  )
  const taskViewTeams = useMemo(
    () => {
      const writableTeamIds = new Set(taskViewController.writableTeamIds)
      return filterTaskViewAudienceTeams(
        teams
          .filter((team) => team.projects.some((project) => project.id === projectId))
          .map((team) => ({ id: team.id, name: team.name })),
        taskViewScope,
      ).filter((team) => writableTeamIds.has(team.id))
    },
    [projectId, taskViewController.writableTeamIds, taskViewScope, teams],
  )
  const {
    data: relationCandidates = emptyTeamIssues,
    error: relationCandidatesError,
    isLoading: isRelationCandidatesLoading,
    key: relationCandidatesKey,
  } = useTeamIssues(
    accessToken,
    selectedWorkItemTeamId,
    Boolean(user && !currentUserError),
    false,
    'project-relation-candidates',
  )
  const resolvedSelectedIssueTeamId = selectedWorkItemTeamId
  const collaboration = useIssueCollaboration({
    accessToken,
    issueId: resolvedSelectedIssue?.id,
    projectId: resolvedSelectedIssue?.assignedProjectId ?? projectId,
    teamId: resolvedSelectedIssueTeamId,
  })
  const artifactIssueId = resolvedSelectedIssue?.id
  const artifactProjectTeamId = selectedWorkItemTeamId
  const issueFileScope = useWorkItemFileScope(artifactIssueId, resolvedSelectedIssueTeamId)
  const projectFileScope = useProjectFileScope(projectId, artifactProjectTeamId)
  const issueArtifacts = useFileArtifacts({
    accessToken,
    scope: issueFileScope,
  })
  const projectFiles = useFileArtifacts({ accessToken, scope: projectFileScope })
  const {
    data: selectedIssueDetail,
    error: detailError,
    isLoading: isSelectedIssueDetailLoading,
    mutate: mutateSelectedIssueDetail,
    key: issueDetailKey,
  } = useTeamIssueDetail(
    accessToken,
    resolvedSelectedIssueTeamId,
    resolvedSelectedIssue?.id,
    true,
    'project-issue-detail',
  )
  const [issueUpdateError, setIssueUpdateError] = useState<readonly [string, string] | undefined>()
  const [scheduleRefreshError, setScheduleRefreshError] = useState<unknown>()
  const selectedIssueUpdateErrorKey = resolvedSelectedIssue
    ? JSON.stringify([
        resolvedSelectedIssue.teamId,
        resolvedSelectedIssue.id,
      ])
    : undefined
  const issueUpdateErrorMessage = issueUpdateError && issueUpdateError[0] === selectedIssueUpdateErrorKey
    ? issueUpdateError[1]
    : undefined
  const projectName =
    activeProject?.name ?? (projectId === 'refero' ? t('tasks.project.refero') : projectId)
  /** Toggles the routed Project in quick access when its Team context is unambiguous. */
  const handleProjectQuickAccessToggle = interactionTeamId && !hasQuickAccessLoadError
    ? () => {
        void onToggleProjectQuickAccess(
          { projectId, teamId: interactionTeamId },
          projectName,
        )
      }
    : undefined
  const projectMembersErrorMessage = useMemo(() => {
    if (!projectMembersError) {
      return undefined
    }

    const message = projectMembersError instanceof Error
      ? projectMembersError.message
      : 'tasks.create.assigneeLoadError'

    return message === 'tasks.create.assigneeLoadError' || message === 'projects.error.loading'
      ? t('tasks.create.assigneeLoadError')
      : message
  }, [projectMembersError, t])
  const projectPermissionsErrorMessage = projectMembersError
    ? t('workspace.permissions.error')
    : undefined
  const currentPath = `${location.pathname}${location.search}${location.hash}`
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      workspaceAccessError,
      planningError,
      planningProjectRolesError,
      ...(planningProjectRolesResult?.errors ?? []),
      projectDirectoryError,
      taskError,
      projectMembersError,
      projectUsersError,
      workItemConfigurationError,
      ...workItemConfigurationLoadResult.errors,
      relationCandidatesError,
      detailError,
      ...(issueArtifacts.sessionErrors ?? []),
      ...(projectFiles.sessionErrors ?? []),
      ...(collaboration.sessionErrors ?? []),
      ...(projectCustomerImpactError ? [projectCustomerImpactError] : []),
    ],
    currentPath,
  )
  /** Redirects an authenticated API failure while preserving the intended return path. */
  const redirectEnterpriseSessionError = (error: unknown, returnPath = currentPath) => {
    const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
      undefined,
      [error],
      returnPath,
    )

    if (!sessionErrorAction?.redirectTo) {
      return false
    }

    if (sessionErrorAction.clearSession) {
      clearAuthSession()
    }
    navigate(sessionErrorAction.redirectTo, { replace: true })
    return true
  }
  const guardEnterpriseSession = async <Result,>(request: Promise<Result>) => {
    try {
      return await request
    } catch (error) {
      redirectEnterpriseSessionError(error)
      throw error
    }
  }
  const scheduleMutations = createTaskScheduleMutationController({
    accessToken,
    guardEnterpriseSession,
    mutatePlanning,
    mutateProjectTasks,
    mutateSelectedIssueDetail,
    mutationRequestRunner,
    onBackgroundRefreshError: (error) => {
      redirectEnterpriseSessionError(error)
      setScheduleRefreshError(error)
    },
    planningAccess,
    planningSnapshot,
    projectId,
    t,
    user,
  })
  const taskErrorMessage = useMemo(() => {
    if (currentUserErrorAction?.kind === 'stay') {
      return t('tasks.error.loading')
    }

    if (!taskError) {
      return undefined
    }

    const message = taskError instanceof Error ? taskError.message : 'tasks.error.loading'

    return message === 'tasks.error.loading' || message === 'issues.error.loading'
      ? t('tasks.error.loading')
      : message
  }, [
    currentUserErrorAction?.kind,
    taskError,
    t,
  ])
  const planningErrorMessage = planningError || planningProjectRolesError || scheduleRefreshError ||
    (planningProjectRolesResult?.errors.length ?? 0) > 0
    ? t('planning.error')
    : undefined
  const isPlanningDependencyLoading = Boolean(planningKey && isPlanningLoading) ||
    Boolean(planningProjectRolesKey && isPlanningProjectRolesLoading) ||
    Boolean(projectDirectoryKey && isProjectDirectoryLoading)
  const detailErrorMessage = issueUpdateErrorMessage ?? (
    detailError ? t('tasks.detail.error') : undefined
  )
  const configurationErrorMessage = failedConfigurationTeamIds.length > 0
    ? t('workItems.configuration.loadError')
    : undefined
  const relationCandidatesErrorMessage = relationCandidatesError
    ? t('tasks.detail.error')
    : undefined
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay') ||
    Boolean(user && isProjectTasksLoading) ||
    Boolean(workItemConfigurationKey && isWorkItemConfigurationLoading)
  const sidebarRouteState = useMemo(
    () => ({
      activeProjectTeamId: interactionTeamId,
      isBusy: isLoading,
    }),
    [interactionTeamId, isLoading],
  )

  useReportWorkspaceSidebarRouteState(sidebarRouteState)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${projectName} | ${t('app.title')}`
  }, [locale, projectName, t])

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
    if (!isCreateTaskRequested) {
      return
    }

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('create')
    setSearchParams(nextSearchParams, { replace: true })
  }, [isCreateTaskRequested, searchParams, setSearchParams])

  useEffect(() => {
    if (!hasAmbiguousIssueSelection) {
      return
    }

    const nextSearchParams = new URLSearchParams(searchParams)

    nextSearchParams.delete('issueId')
    for (const key of issueCollaborationTargetSearchParams) {
      nextSearchParams.delete(key)
    }
    setSearchParams(nextSearchParams, {
      replace: true,
      state: ambiguousIssueSelectionLocationState,
    })
  }, [hasAmbiguousIssueSelection, searchParams, setSearchParams])

  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'
  const workspaceId = (
    user?.attributes['custom:workspace_id'] ??
    user?.attributes['custom:directory_id'] ??
    ''
  ).trim()

  /** Mirrors the server's manager check for one visible dependency endpoint. */
  const canManageScheduleDependencyEndpoint = (endpoint: WorkItemDependencyEndpoint) =>
    canManagePlanningWorkItemDependencyEndpoint(
      user,
      endpoint,
      planningSnapshot?.workItems ?? [],
      planningAccess,
    )

  const taskViewWriteCapabilities = {
    writableProjectScopes: taskViewController.writableProjectScopes,
    writableTeamIds: taskViewController.writableTeamIds,
  }

  /** Checks one concrete Work Item against the Team-qualified task-view write scopes. */
  const canMutateProjectTaskTarget = (
    target: Pick<CanonicalWorkItem, 'assignedProjectId' | 'teamId'>,
  ) => canWriteTaskViewWorkItem(taskViewWriteCapabilities, target)

  /** Creates the stable forbidden error shared by every guarded Project task action. */
  const denyProjectTaskMutation = (): never => {
    throw new TeamIssuesApiError(
      403,
      t('taskViews.action.unavailable'),
      'TeamTaskActionAccessDenied',
    )
  }

  /** Rejects a Work Item mutation before any request is sent when its exact scope is read-only. */
  const requireProjectTaskWriteScope = (
    target: Pick<CanonicalWorkItem, 'assignedProjectId' | 'teamId'>,
  ) => {
    if (canMutateProjectTaskTarget(target)) return
    denyProjectTaskMutation()
  }

  /** Resolves the newest locally available snapshot for one Team-local Work Item identity. */
  const resolveProjectTaskSnapshot = (teamId: string, workItemId: string) => {
    const detailTask = selectedIssueDetail?.issue.id === workItemId &&
      selectedIssueDetail.issue.teamId === teamId
      ? selectedIssueDetail.issue
      : undefined
    const listTask = tasks.find((task) => task.id === workItemId && task.teamId === teamId)
    return detailTask && (!listTask || detailTask.revision >= listTask.revision)
      ? detailTask
      : listTask
  }

  /** Validates every current and destination scope represented by a bulk mutation. */
  const requireBulkOperationWriteScopes = (
    items: readonly { teamId: string; workItemId: string }[],
    action: BulkOperationRequest['action'],
  ) => {
    const allowed = items.every((item) => {
      const task = resolveProjectTaskSnapshot(item.teamId, item.workItemId)
      if (!task || !canMutateProjectTaskTarget(task)) return false

      if (action.type === 'move') {
        return canMutateProjectTaskTarget({
          assignedProjectId: action.targetProjectId ?? undefined,
          teamId: task.teamId,
        })
      }
      if (action.type !== 'edit' || action.patch.assignedProjectId === undefined) return true

      const assignedProjectId = action.patch.assignedProjectId
      if (assignedProjectId !== null && typeof assignedProjectId !== 'string') return false
      return canMutateProjectTaskTarget({
        assignedProjectId: assignedProjectId ?? undefined,
        teamId: task.teamId,
      })
    })
    if (allowed) return
    throw new TeamIssuesApiError(
      403,
      t('taskViews.action.unavailable'),
      'TeamTaskActionAccessDenied',
    )
  }

  const handleCreateTask = async (
    input: CreateWorkItemInput,
    context?: TaskCreateContext,
  ) => {
    if (!accessToken) {
      throw new Error(t('issues.error.create'))
    }

    const targetTeamId = context?.teamId ?? creationTeam?.id
    const targetProjectId = context?.projectId ?? input.assignedProjectId ?? projectId

    if (!targetTeamId) {
      throw new Error(t('issues.error.create'))
    }
    requireProjectTaskWriteScope({
      assignedProjectId: targetProjectId,
      teamId: targetTeamId,
    })

    const issue = await guardEnterpriseSession(mutationRequestRunner.run(
      `issue:create:${targetTeamId}:${targetProjectId}`,
      JSON.stringify([targetTeamId, targetProjectId, input]),
      (context) => createTeamIssue(
        targetTeamId,
        accessToken,
        {
          ...input,
          assignedProjectId: targetProjectId,
        },
        context,
      ),
    ))
    const navigationPath = preserveTaskViewUrlState(
      createProjectIssuesPath(targetProjectId, targetTeamId, issue.id),
      searchParams,
    )
    let shouldNavigate = true
    try {
      await mutateProjectTasks()
    } catch (error) {
      shouldNavigate = !redirectEnterpriseSessionError(error, navigationPath)
    }
    if (shouldNavigate) navigate(navigationPath)
    return { navigationPath, task: issue }
  }

  const handleUpdateProjectMember = async (
    currentProjectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      `member:update:${currentProjectId}:${memberKey}`,
      JSON.stringify(input),
      (context) => updateProjectMember(accessToken, currentProjectId, memberKey, input, context),
    ))
    await mutateProjectMembers()
  }

  const handleRemoveProjectMember = async (currentProjectId: string, memberKey: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      `member:remove:${currentProjectId}:${memberKey}`,
      memberKey,
      (context) => removeProjectMember(accessToken, currentProjectId, memberKey, context),
    ))
    await mutateProjectMembers()
  }

  const handleLoadMoreProjectUsers = async () => {
    if (!accessToken || !projectUsersNextToken || !canManageProjectMembers) {
      return
    }

    const currentPageKey = createProjectUsersPageKey(projectId, projectUserQuery)
    const currentExtraUsers = projectUsersExtraPage?.key === currentPageKey
      ? projectUsersExtraPage.users
      : emptyProjectUsers
    const response = await guardEnterpriseSession(getProjectUsers(accessToken, projectId, {
      limit: 20,
      nextToken: projectUsersNextToken,
      query: projectUserQuery,
    }))

    setProjectUsersExtraPage({
      key: currentPageKey,
      nextToken: response.nextToken,
      users: mergeProjectUsers(currentExtraUsers, response.users),
    })
  }

  const handleSelectedIssueChange = (task: CanonicalWorkItem) => {
    const nextTeamId = task.teamId ?? activeTeam?.id

    if (!nextTeamId) {
      return
    }

    setIssueUpdateError(undefined)
    navigate(preserveTaskViewUrlState(
      createProjectIssuesPath(task.assignedProjectId ?? projectId, nextTeamId, task.id),
      searchParams,
    ))
  }

  /** Persists collaboration section navigation without leaving the selected Work Item. */
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

  /** Updates a visible Work Item with optimistic cache projection and conflict rollback. */
  const handleUpdateTask = async (
    task: CanonicalWorkItem,
    input: UpdateTeamIssueInput,
  ): Promise<CanonicalWorkItem> => {
    if (!accessToken) {
      throw new Error(t('tasks.action.updateError'))
    }

    const detailTask = selectedIssueDetail?.issue.id === task.id &&
      selectedIssueDetail.issue.teamId === task.teamId
      ? selectedIssueDetail.issue
      : undefined
    const listTask = tasks.find((candidate) =>
      candidate.id === task.id && candidate.teamId === task.teamId
    )
    const latestKnownTask = detailTask && (!listTask || detailTask.revision >= listTask.revision)
      ? detailTask
      : listTask

    if (!latestKnownTask) {
      throw new Error(t('tasks.action.updateError'))
    }
    if (latestKnownTask.revision !== task.revision) {
      await Promise.all([mutateProjectTasks(), mutateSelectedIssueDetail()])
      throw new TeamIssuesApiError(
        409,
        t('tasks.action.conflict'),
        'WorkItemRevisionConflict',
      )
    }

    requireProjectTaskWriteScope({
      assignedProjectId: input.assignedProjectId === undefined
        ? latestKnownTask.assignedProjectId
        : input.assignedProjectId ?? undefined,
      teamId: latestKnownTask.teamId,
    })

    const currentTask = task

    const configuration = workItemConfigurationLoadResult.configurationsByTeam[currentTask.teamId]?.configuration ??
      selectedIssueDetail?.resolvedConfiguration?.configuration
    const optimisticTask = applyTaskPatchOptimistically(currentTask, input, configuration)
    /** Returns whether a candidate is the same Team-local Work Item. */
    const matchesTask = (candidate: CanonicalWorkItem) =>
      candidate.id === currentTask.id && candidate.teamId === currentTask.teamId

    await mutateProjectTasks(
      (currentTasks = []) => currentTasks.map((candidate) =>
        matchesTask(candidate) ? optimisticTask : candidate,
      ),
      { revalidate: false },
    )

    try {
      const updatedTask = await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:update:${currentTask.teamId}:${currentTask.id}`,
        JSON.stringify([currentTask.revision, input]),
        (context) => updateTeamIssue(
          currentTask.teamId,
          currentTask.id,
          accessToken,
          {
            ...input,
            expectedRevision: currentTask.revision,
          },
          context,
        ),
      ))
      await mutateProjectTasks(
        (currentTasks = []) => currentTasks.map((candidate) =>
          matchesTask(candidate) ? updatedTask : candidate,
        ),
        { revalidate: false },
      )
      // Revalidate after the optimistic replacement so a Project reassignment
      // removes the item from this Project's list instead of leaving stale data.
      await mutateProjectTasks()
      await mutateSelectedIssueDetail()
      return updatedTask
    } catch (error) {
      await mutateProjectTasks(
        (currentTasks = []) => currentTasks.map((candidate) =>
          matchesTask(candidate) ? currentTask : candidate,
        ),
        { revalidate: false },
      )
      redirectEnterpriseSessionError(error)
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        await Promise.all([mutateProjectTasks(), mutateSelectedIssueDetail()])
      }
      throw error
    }
  }

  const handleUpdateIssue = async (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => {
    if (!accessToken) {
      return
    }

    const currentIssue = selectedIssueDetail?.issue.id === issueId &&
      selectedIssueDetail.issue.teamId === teamId
      ? selectedIssueDetail.issue
      : tasks.find((issue) => issue.id === issueId && issue.teamId === teamId)

    if (!currentIssue) {
      return
    }

    requireProjectTaskWriteScope(currentIssue)

    setIssueUpdateError(undefined)
    const currentIssueUpdateErrorKey = JSON.stringify([
      currentIssue.teamId,
      currentIssue.id,
    ])

    try {
      return await handleUpdateTask(currentIssue, input)
    } catch (error) {
      redirectEnterpriseSessionError(error)
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        setIssueUpdateError([currentIssueUpdateErrorKey, t('tasks.detail.conflict')])
        await Promise.all([mutateProjectTasks(), mutateSelectedIssueDetail()])
      } else {
        setIssueUpdateError([currentIssueUpdateErrorKey, t('tasks.detail.error')])
      }

      throw error
    }
  }

  const revalidateAfterBulkOperation = async () => {
    await Promise.all([
      mutateProjectTasks(),
      mutateSelectedIssueDetail(),
    ])
  }

  const handleBulkPreview = async (request: BulkOperationRequest) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }
    requireBulkOperationWriteScopes(request.items, request.action)

    return guardEnterpriseSession(mutationRequestRunner.run(
      'bulk:preview',
      JSON.stringify(request),
      (context) => previewBulkOperation(accessToken, request, context),
    ))
  }

  const handleBulkApply = async (
    request: BulkOperationRequest,
    preview: BulkOperationPreview,
  ) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }
    requireBulkOperationWriteScopes(request.items, request.action)

    const operation = await guardEnterpriseSession(mutationRequestRunner.run(
      'bulk:apply',
      JSON.stringify([request, preview.operationToken]),
      (context) => applyBulkOperation(
        accessToken,
        { ...request, operationToken: preview.operationToken },
        context,
      ),
    ))
    await revalidateAfterBulkOperation()
    return operation
  }

  const handleBulkRetry = async (operationId: string, operation?: BulkOperation) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }
    const currentOperation = operation
    if (!currentOperation) {
      return denyProjectTaskMutation()
    }
    requireBulkOperationWriteScopes(currentOperation.items, currentOperation.action)

    const nextOperation = await guardEnterpriseSession(mutationRequestRunner.run(
      `bulk:retry:${operationId}`,
      operationId,
      (context) => retryBulkOperation(accessToken, operationId, context),
    ))
    await revalidateAfterBulkOperation()
    return nextOperation
  }

  const handleBulkUndo = async (operationId: string, operation?: BulkOperation) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }
    const currentOperation = operation
    if (!currentOperation) {
      return denyProjectTaskMutation()
    }
    requireBulkOperationWriteScopes(currentOperation.items, currentOperation.action)

    const nextOperation = await guardEnterpriseSession(mutationRequestRunner.run(
      `bulk:undo:${operationId}`,
      operationId,
      (context) => undoBulkOperation(accessToken, operationId, context),
    ))
    await revalidateAfterBulkOperation()
    return nextOperation
  }

  const handleAddRelation = async (
    issueId: string,
    input: WorkItemRelationEditorInput,
  ) => {
    const teamId = selectedIssueDetail?.issue.id === issueId
      ? selectedIssueDetail.issue.teamId
      : resolvedSelectedIssueTeamId

    if (!accessToken || !teamId) {
      return
    }

    const currentIssue = resolveProjectTaskSnapshot(teamId, issueId)
    if (!currentIssue) return
    requireProjectTaskWriteScope(currentIssue)

    const graphRevision = readSelectedRelationGraphRevision(selectedIssueDetail, issueId, t)

    try {
      await mutationRequestRunner.run(
        `issue:relation:create:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, input]),
        (context) => createWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          { ...input, expectedGraphRevision: graphRevision },
          context,
        ),
      )
      await mutateSelectedIssueDetail()
    } catch (error) {
      redirectEnterpriseSessionError(error)
      await refreshRelationDetailAfterConflict(error, mutateSelectedIssueDetail)
      throw error
    }
  }

  const handleDeleteRelation = async (
    issueId: string,
    relation: WorkItemRelation,
  ) => {
    const teamId = selectedIssueDetail?.issue.id === issueId
      ? selectedIssueDetail.issue.teamId
      : resolvedSelectedIssueTeamId

    if (!accessToken || !teamId) {
      return
    }

    const currentIssue = resolveProjectTaskSnapshot(teamId, issueId)
    if (!currentIssue) return
    requireProjectTaskWriteScope(currentIssue)

    const graphRevision = readSelectedRelationGraphRevision(selectedIssueDetail, issueId, t)

    try {
      await mutationRequestRunner.run(
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
      )
      await mutateSelectedIssueDetail()
    } catch (error) {
      redirectEnterpriseSessionError(error)
      await refreshRelationDetailAfterConflict(error, mutateSelectedIssueDetail)
      throw error
    }
  }

  /** Resolves one dependency endpoint to its current Team-qualified Project ownership. */
  const resolveScheduleDependencyTarget = (endpoint: WorkItemDependencyEndpoint) => {
    const task = resolveProjectTaskSnapshot(endpoint.teamId, endpoint.workItemId)
    if (task) return task
    const planningWorkItem = planningSnapshot?.workItems.find((item) =>
      item.teamId === endpoint.teamId && item.id === endpoint.workItemId
    )
    return planningWorkItem
      ? {
          assignedProjectId: planningWorkItem.projectId,
          teamId: planningWorkItem.teamId,
        }
      : undefined
  }

  /** Rejects dependency changes unless every endpoint has an exact writable scope. */
  const requireScheduleDependencyWriteScopes = (
    endpoints: readonly WorkItemDependencyEndpoint[],
  ) => {
    if (endpoints.every((endpoint) => {
      const target = resolveScheduleDependencyTarget(endpoint)
      return target !== undefined && canMutateProjectTaskTarget(target)
    })) return
    denyProjectTaskMutation()
  }

  /** Guards one direct schedule preview against the current Work Item ownership scope. */
  const handlePreviewScheduleChange = (
    task: CanonicalWorkItem,
    operation: Parameters<typeof scheduleMutations.previewScheduleChange>[1],
  ) => {
    requireProjectTaskWriteScope(task)
    return scheduleMutations.previewScheduleChange(task, operation)
  }

  /** Guards one confirmed schedule mutation against the current Work Item ownership scope. */
  const handleConfirmScheduleChange = (
    task: CanonicalWorkItem,
    operation: Parameters<typeof scheduleMutations.confirmScheduleChange>[1],
    preview: Parameters<typeof scheduleMutations.confirmScheduleChange>[2],
  ) => {
    requireProjectTaskWriteScope(task)
    return scheduleMutations.confirmScheduleChange(task, operation, preview)
  }

  /** Guards creation of a canonical dependency across both endpoint scopes. */
  const handleCreateScheduleDependency = async (input: WorkItemDependencyCreateDraft) => {
    requireScheduleDependencyWriteScopes([input.predecessor, input.successor])
    await scheduleMutations.createScheduleDependency(input)
  }

  /** Guards deletion of a canonical dependency across both endpoint scopes. */
  const handleDeleteScheduleDependency = async (
    dependency: Parameters<typeof scheduleMutations.deleteScheduleDependency>[0],
  ) => {
    requireScheduleDependencyWriteScopes([
      dependency.predecessor,
      dependency.successor,
    ])
    await scheduleMutations.deleteScheduleDependency(dependency)
  }

  /** Guards edits to a canonical dependency across both endpoint scopes. */
  const handleUpdateScheduleDependency = async (
    dependency: Parameters<typeof scheduleMutations.updateScheduleDependency>[0],
    patch: Parameters<typeof scheduleMutations.updateScheduleDependency>[1],
  ) => {
    requireScheduleDependencyWriteScopes([
      dependency.predecessor,
      dependency.successor,
    ])
    await scheduleMutations.updateScheduleDependency(dependency, patch)
  }

  const canMutateProjectTasks = taskViewController.writableProjectScopes.some((scope) =>
    scope.projectId === projectId
  )
  const canCreateProjectTask = Boolean(creationTeam) && creationTeam !== undefined &&
    canMutateProjectTaskTarget({
      assignedProjectId: projectId,
      teamId: creationTeam.id,
    }) && Object.keys(
    workItemConfigurationLoadResult.configurationsByTeam,
  ).length > 0
  const projectTaskViewState = taskViewDefinitionToProjectState(
    taskViewController.effectiveDefinition,
  )
  const taskViewOptions = taskViewController.views.map(createTaskViewOption)
  const activeTaskViewOption = taskViewController.activeSavedView
    ? createTaskViewOption(taskViewController.activeSavedView)
    : undefined
  const taskViewToolbar = (
    <TaskViewToolbar
      builtInName={t('tasks.tab.table')}
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
      onUpdate={taskViewController.activeSavedView?.canEdit
        ? taskViewController.updateActiveView
        : undefined}
      selectedView={activeTaskViewOption}
      settings={taskViewDefinitionToPresentationSettings(
        taskViewController.effectiveDefinition,
      )}
      supportsColumnLayoutMetadata={projectTaskViewState.activeTab === 'table'}
      supportsEmptyGroups={projectTaskViewState.activeTab === 'board'}
      supportsLayoutPresentation={projectTaskViewState.activeTab === 'table' ||
        projectTaskViewState.activeTab === 'board'}
      supportsKeyboardSelection
      teams={taskViewTeams}
      t={t}
      views={taskViewOptions}
    />
  )

  const aiSummaryAssistanceEnabled = isAiAssistanceTaskEnabled?.('summary') ?? false
  const aiPlanningAssistanceEnabled = isAiAssistanceTaskEnabled?.('planning') ?? aiAssistanceUiEnabled

  return (
    <TaskScreen
      key={projectId}
      aiAssistanceEnabled={aiPlanningAssistanceEnabled}
      aiSummaryAssistanceEnabled={aiSummaryAssistanceEnabled}
      renderAiAssistance={taskDetailAiAssistanceRenderer}
      workspaceId={workspaceId}
      configurationErrorMessage={configurationErrorMessage}
      accessToken={accessToken}
      onAuthenticatedApiError={(error) => {
        redirectEnterpriseSessionError(error)
      }}
      activeTaskViewId={taskViewController.activeSavedView?.id}
      isLoading={isLoading}
      isProjectQuickAccess={interactionTeamId
        ? isProjectQuickAccess({ projectId, teamId: interactionTeamId })
        : false}
      isProjectQuickAccessSaving={isQuickAccessLoading || isQuickAccessSaving}
      isRelationCandidatesLoading={Boolean(relationCandidatesKey && isRelationCandidatesLoading)}
      isPlanningLoading={isPlanningDependencyLoading}
      locale={locale}
      activeProjectTeamId={interactionTeamId}
      onCreateTask={canCreateProjectTask ? handleCreateTask : undefined}
      canMutateTask={canMutateProjectTaskTarget}
      onAddRelation={canMutateProjectTasks ? handleAddRelation : undefined}
      assigneeErrorMessage={projectMembersErrorMessage}
      assigneeOptions={activeProjectMembers}
      canAccessTriage={canAccessTriage}
      canManageProjectMembers={canManageProjectMembers}
      canManageScheduleDependencyEndpoint={canManageScheduleDependencyEndpoint}
      collaboration={collaboration}
      collaborationRoute={
        {
          collaborationTab,
          focusedContextItemId,
          focusedSourceId,
          focusedSourceKind,
          focusedActivityEventId,
          onCollaborationTabChange: handleCollaborationTabChange,
          onCollaborationSourceChange: handleCollaborationSourceChange,
        } satisfies IssueCollaborationRoute
      }
      currentUserProjectKey={currentUserProjectKey}
      artifacts={issueArtifacts}
      currentWorkspaceMemberKey={workspaceAccess?.currentMember.memberKey}
      detailErrorMessage={detailErrorMessage}
      defaultCreateTaskOpen={isCreateTaskRequested}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      initialSelectedTaskId={resolvedSelectedIssue?.id}
      isAssigneeOptionsLoading={Boolean(projectMembersKey && isProjectMembersLoading)}
      isProjectUsersLoading={Boolean(projectUsersKey && isProjectUsersLoading)}
      isSelectedIssueDetailLoading={Boolean(issueDetailKey && isSelectedIssueDetailLoading)}
      isSystemAdmin={user?.isSystemAdmin}
      onLoadMoreProjectUsers={canManageProjectMembers ? handleLoadMoreProjectUsers : undefined}
      onProjectUserQueryChange={canManageProjectMembers ? setProjectUserQuery : undefined}
      onProjectQuickAccessToggle={handleProjectQuickAccessToggle}
      onRemoveProjectMember={canManageProjectMembers ? handleRemoveProjectMember : undefined}
      onDeleteRelation={canMutateProjectTasks ? handleDeleteRelation : undefined}
      onSelectedIssueChange={handleSelectedIssueChange}
      onUpdateIssue={canMutateProjectTasks ? handleUpdateIssue : undefined}
      onUpdateTask={canMutateProjectTasks ? handleUpdateTask : undefined}
      onPreviewScheduleChange={canMutateProjectTasks
        ? handlePreviewScheduleChange
        : undefined}
      onConfirmScheduleChange={canMutateProjectTasks
        ? handleConfirmScheduleChange
        : undefined}
      onCreateScheduleDependency={canMutateProjectTasks && accessToken && planningSnapshot &&
          !planningErrorMessage && !isPlanningDependencyLoading
        ? handleCreateScheduleDependency
        : undefined}
      onDeleteScheduleDependency={canMutateProjectTasks && accessToken && planningSnapshot &&
          !planningErrorMessage && !isPlanningDependencyLoading
        ? handleDeleteScheduleDependency
        : undefined}
      onRetryPlanning={planningErrorMessage
        ? () => void Promise.all([mutatePlanning(), mutatePlanningProjectRoles()])
            .then(() => {
              setScheduleRefreshError(undefined)
            })
            .catch(() => undefined)
        : undefined}
      onUpdateScheduleDependency={canMutateProjectTasks && accessToken && planningSnapshot &&
          !planningErrorMessage && !isPlanningDependencyLoading
        ? handleUpdateScheduleDependency
        : undefined}
      planningErrorMessage={planningErrorMessage}
      planningSnapshot={planningSnapshot}
      onUpdateProjectMember={canManageProjectMembers ? handleUpdateProjectMember : undefined}
      onBulkApply={canMutateProjectTasks && workspaceId ? handleBulkApply : undefined}
      onBulkPreview={canMutateProjectTasks && workspaceId ? handleBulkPreview : undefined}
      onBulkRetry={canMutateProjectTasks && workspaceId ? handleBulkRetry : undefined}
      onBulkUndo={canMutateProjectTasks && workspaceId ? handleBulkUndo : undefined}
      projectId={projectId}
      projectFiles={projectFiles}
      projectMembers={projectMembers}
      projectMembersErrorMessage={projectPermissionsErrorMessage}
      projectName={projectName}
      projectUserQuery={projectUserQuery}
      projectUsers={projectUsers}
      projectUsersErrorMessage={projectUsersErrorMessage}
      projectUsersNextToken={projectUsersNextToken}
      relationCandidates={relationCandidates}
      relationCandidatesErrorMessage={relationCandidatesErrorMessage}
      selectedIssueDetail={selectedIssueDetail}
      projectCustomerImpact={projectCustomerImpactKey ? projectCustomerImpact : undefined}
      resolvedConfiguration={listConfigurationTeamId ? resolvedConfiguration : undefined}
      resolvedConfigurationsByTeam={workItemConfigurationLoadResult.configurationsByTeam}
      configurationFailedTeamIds={failedConfigurationTeamIds}
      onRetryConfigurations={() => void mutateWorkItemConfigurations()}
      taskErrorMessage={taskErrorMessage}
      taskViewToolbar={taskViewToolbar}
      taskViewDefinition={taskViewController.effectiveDefinition}
      taskViewPresentation={taskViewDefinitionToPresentationSettings(
        taskViewController.effectiveDefinition,
      )}
      tasks={tasks}
      teamName={interactionTeam?.name}
      teams={teams}
      userInitial={userInitial}
      viewState={projectTaskViewState}
      onViewStateChange={(nextViewState) => {
        taskViewController.setEffectiveDefinition(
          projectStateToTaskViewDefinition(
            taskViewController.effectiveDefinition,
            nextViewState,
          ),
        )
      }}
      workspaceMembers={workspaceAccess?.members ?? emptyWorkspaceMembers}
    />
  )
}
