import type {
  BulkOperationPreview,
  BulkOperationRequest,
  ResolvedWorkItemConfiguration,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
} from '../../auth/api'
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
import { useUnreadNotificationCount } from '../../notifications/mutations/useNotifications'
import {
  applyBulkOperation,
  previewBulkOperation,
  retryBulkOperation,
  undoBulkOperation,
} from '../../bulk-operations/api'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  getProjectUsers,
  isActiveProjectAssignmentCandidate,
  type ProjectMember,
  type ProjectUser,
  type UpdateProjectMemberInput,
  removeProjectMember,
  updateProjectMember,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import {
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
import {
  useProjectIssues,
  useTeamIssueDetail,
  useTeamIssues,
} from '../../issues/queries/useWorkItems'
import {
  useIssueCollaboration,
} from '../../issues/mutations/useIssueCollaboration'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../../shared/routing/paths'
import {
  type CreateProjectTaskInput,
  type ProjectTask,
} from '../../tasks/api'
import {
  createProjectUsersPageKey,
  mergeProjectUsers,
  normalizeProjectIssueError,
  resolveCurrentUserProjectKey,
  resolveProjectTaskRouteContext,
} from '../../tasks/model/taskRoute'
import { TaskScreen } from '../../tasks/ui/TaskScreen'
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
  readSelectedRelationGraphRevision,
  refreshRelationDetailAfterConflict,
} from '../../work-items/model/workItemDisplay'
import type { WorkItemRelationEditorInput } from '../../work-items/ui/WorkItemRelationsEditor'

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
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = params.projectId ?? 'refero'
  const selectedTeamId = searchParams.get('teamId') ?? undefined
  const selectedIssueId = searchParams.get('issueId') ?? undefined
  const focusedCommentId = searchParams.get('commentId')?.trim() || undefined
  const focusedRootCommentId = searchParams.get('rootCommentId')?.trim() || undefined
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
  const inboxCount = useUnreadNotificationCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const { data: workspaceAccess, error: workspaceAccessError } = useWorkspaceAccess(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const {
    data: teams = [],
    error: projectDirectoryError,
    mutate: mutateProjectDirectory,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const {
    data: projectIssues = emptyTeamIssues,
    error: taskError,
    isLoading: isProjectTasksLoading,
    mutate: mutateProjectTasks,
  } = useProjectIssues(
    accessToken,
    projectId,
    Boolean(user && !currentUserError),
    normalizeProjectIssueError,
  )
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
  const canManageStructure = canManageWorkspaceStructure(user)
  const canMutateContent = canMutateWorkspaceContent(user)
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
  } = resolveProjectTaskRouteContext({
    projectId,
    projectIssues,
    selectedIssueId,
    selectedTeamId,
    suppressIssueFallback: location.state === ambiguousIssueSelectionLocationState,
    teams,
  })
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
  const {
    data: relationCandidates = emptyTeamIssues,
    error: relationCandidatesError,
    isLoading: isRelationCandidatesLoading,
    key: relationCandidatesKey,
  } = useTeamIssues(
    accessToken,
    selectedWorkItemTeamId,
    Boolean(user && !currentUserError),
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
    ],
    currentPath,
  )
  const redirectEnterpriseSessionError = (error: unknown) => {
    const sessionErrorAction = resolveEnterpriseSessionErrorsAction(
      undefined,
      [error],
      currentPath,
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
  const taskErrorMessage = useMemo(() => {
    if (currentUserErrorAction?.kind === 'stay') {
      return t('tasks.error.loading')
    }

    if (!taskError) {
      return undefined
    }

    const message = taskError instanceof Error ? taskError.message : 'tasks.error.loading'

    return message === 'tasks.error.loading' ? t('tasks.error.loading') : message
  }, [currentUserErrorAction?.kind, taskError, t])
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
    nextSearchParams.delete('commentId')
    nextSearchParams.delete('rootCommentId')
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

  const handleCreateTask = async (input: CreateProjectTaskInput) => {
    if (!accessToken) {
      return
    }

    if (!creationTeam) {
      throw new Error(t('issues.error.create'))
    }

    const issue = await guardEnterpriseSession(mutationRequestRunner.run(
      'issue:create',
      JSON.stringify([creationTeam.id, projectId, input]),
      (context) => createTeamIssue(
        creationTeam.id,
        accessToken,
        {
          ...input,
          assignedProjectId: projectId,
        },
        context,
      ),
    ))
    await mutateProjectTasks()
    navigate(createProjectIssuesPath(projectId, creationTeam.id, issue.id))
  }

  const handleCreateTeam = async (input: CreateProjectDirectoryTeamInput) => {
    if (!accessToken) {
      return
    }

    try {
      await mutationRequestRunner.run('team:create', JSON.stringify(input), (context) =>
        createProjectDirectoryTeam(accessToken, input, context),
      )
      await mutateProjectDirectory()
    } catch (error) {
      redirectEnterpriseSessionError(error)
      console.error('Failed to create team:', error)
      throw error
    }
  }

  const handleCreateProject = async (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    try {
      await mutationRequestRunner.run(
        'project:create',
        JSON.stringify([teamId, input]),
        (context) => createProjectDirectoryProject(accessToken, teamId, input, context),
      )
      await mutateProjectDirectory()
    } catch (error) {
      redirectEnterpriseSessionError(error)
      console.error('Failed to create project:', error)
      throw error
    }
  }

  const handleArchiveTeam = async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run('team:archive', teamId, (context) =>
      archiveProjectDirectoryTeam(accessToken, teamId, context),
    ))
    await mutateProjectDirectory()

    if (activeTeam?.id === teamId) {
      navigate(workspaceNavPaths.dashboard)
    }
  }

  const handleArchiveProject = async (teamId: string, archivedProjectId: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([teamId, archivedProjectId]),
      (context) => archiveProjectDirectoryProject(
        accessToken,
        teamId,
        archivedProjectId,
        context,
      ),
    ))
    await mutateProjectDirectory()

    if (projectId === archivedProjectId && activeTeam?.id === teamId) {
      navigate(workspaceNavPaths.dashboard)
    }
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

  const handleSelectedIssueChange = (task: ProjectTask) => {
    const nextTeamId = task.teamId ?? activeTeam?.id

    if (!nextTeamId) {
      return
    }

    setIssueUpdateError(undefined)
    navigate(createProjectIssuesPath(task.assignedProjectId ?? projectId, nextTeamId, task.id))
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

    setIssueUpdateError(undefined)
    const currentIssueUpdateErrorKey = JSON.stringify([
      currentIssue.teamId,
      currentIssue.id,
    ])

    try {
      await mutationRequestRunner.run(
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
      )
      await mutateProjectTasks()
      await mutateSelectedIssueDetail()
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

  const handleBulkRetry = async (operationId: string) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }

    const operation = await guardEnterpriseSession(mutationRequestRunner.run(
      `bulk:retry:${operationId}`,
      operationId,
      (context) => retryBulkOperation(accessToken, operationId, context),
    ))
    await revalidateAfterBulkOperation()
    return operation
  }

  const handleBulkUndo = async (operationId: string) => {
    if (!accessToken) {
      throw new Error(t('bulk.error'))
    }

    const operation = await guardEnterpriseSession(mutationRequestRunner.run(
      `bulk:undo:${operationId}`,
      operationId,
      (context) => undoBulkOperation(accessToken, operationId, context),
    ))
    await revalidateAfterBulkOperation()
    return operation
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

  return (
    <TaskScreen
      workspaceId={workspaceId}
      configurationErrorMessage={configurationErrorMessage}
      accessToken={accessToken}
      isLoading={isLoading}
      isRelationCandidatesLoading={Boolean(relationCandidatesKey && isRelationCandidatesLoading)}
      locale={locale}
      activeProjectTeamId={interactionTeamId}
      onSelectProject={(nextProjectId, teamId) =>
        navigate(createProjectIssuesPath(nextProjectId, teamId))
      }
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectTeamView={(teamId, viewId) =>
        navigate(createTeamViewPath(teamId, viewId))
      }
      onCreateProject={canManageStructure ? handleCreateProject : undefined}
      onCreateTeam={canManageStructure ? handleCreateTeam : undefined}
      onArchiveProject={canManageStructure ? handleArchiveProject : undefined}
      onArchiveTeam={canManageStructure ? handleArchiveTeam : undefined}
      onCreateTask={canMutateContent && creationTeam &&
        Boolean(workItemConfigurationLoadResult.configurationsByTeam[creationTeam.id])
        ? handleCreateTask
        : undefined}
      onAddRelation={canMutateContent ? handleAddRelation : undefined}
      assigneeErrorMessage={projectMembersErrorMessage}
      assigneeOptions={activeProjectMembers}
      canManageProjectMembers={canManageProjectMembers}
      collaboration={collaboration}
      artifacts={issueArtifacts}
      currentWorkspaceMemberKey={workspaceAccess?.currentMember.memberKey}
      detailErrorMessage={detailErrorMessage}
      defaultCreateTaskOpen={isCreateTaskRequested}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      inboxCount={inboxCount}
      initialSelectedTaskId={resolvedSelectedIssue?.id}
      isAssigneeOptionsLoading={Boolean(projectMembersKey && isProjectMembersLoading)}
      isProjectUsersLoading={Boolean(projectUsersKey && isProjectUsersLoading)}
      isSelectedIssueDetailLoading={Boolean(issueDetailKey && isSelectedIssueDetailLoading)}
      isSystemAdmin={user?.isSystemAdmin}
      onLoadMoreProjectUsers={canManageProjectMembers ? handleLoadMoreProjectUsers : undefined}
      onProjectUserQueryChange={canManageProjectMembers ? setProjectUserQuery : undefined}
      onRemoveProjectMember={canManageProjectMembers ? handleRemoveProjectMember : undefined}
      onDeleteRelation={canMutateContent ? handleDeleteRelation : undefined}
      onSelectedIssueChange={handleSelectedIssueChange}
      onUpdateIssue={canMutateContent ? handleUpdateIssue : undefined}
      onUpdateProjectMember={canManageProjectMembers ? handleUpdateProjectMember : undefined}
      onBulkApply={canMutateContent && workspaceId ? handleBulkApply : undefined}
      onBulkPreview={canMutateContent && workspaceId ? handleBulkPreview : undefined}
      onBulkRetry={canMutateContent && workspaceId ? handleBulkRetry : undefined}
      onBulkUndo={canMutateContent && workspaceId ? handleBulkUndo : undefined}
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
      resolvedConfiguration={listConfigurationTeamId ? resolvedConfiguration : undefined}
      resolvedConfigurationsByTeam={workItemConfigurationLoadResult.configurationsByTeam}
      configurationFailedTeamIds={failedConfigurationTeamIds}
      onRetryConfigurations={() => void mutateWorkItemConfigurations()}
      taskErrorMessage={taskErrorMessage}
      tasks={tasks}
      teamName={interactionTeam?.name}
      teams={teams}
      userInitial={userInitial}
      workspaceMembers={workspaceAccess?.members ?? emptyWorkspaceMembers}
    />
  )
}
