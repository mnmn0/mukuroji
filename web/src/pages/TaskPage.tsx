import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import useSWR from 'swr'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  getCurrentUser,
  type CurrentUser,
} from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import { createMutationRequestRunner } from '../api/mutationHeaders'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../i18n'
import { useUnreadNotificationCount } from '../notifications/useNotifications'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  getProjectDirectory,
  getProjectMembers,
  getProjectUsers,
  isActiveProjectAssignmentCandidate,
  type ProjectMember,
  type ProjectUser,
  type UpdateProjectMemberInput,
  removeProjectMember,
  updateProjectMember,
} from '../projects/api'
import {
  createTeamIssue,
  getProjectIssues,
  getTeamIssueDetail,
  TeamIssuesApiError,
  type TeamIssue,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../issues/api'
import { useIssueCollaboration } from '../issues/useIssueCollaboration'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  type CreateProjectTaskInput,
  ProjectTasksApiError,
  type ProjectTask,
} from '../tasks/api'
import { TaskScreen } from '../tasks'
import {
  findIssueBySelection,
  findProjectInTeams,
  findTeamForProject,
} from '../tasks/taskSelection'
import { getWorkspaceAccess, type WorkspaceMember } from '../workspace/api'

export { TaskScreen } from '../tasks'

const emptyProjectMembers: ProjectMember[] = []
const emptyProjectUsers: ProjectUser[] = []
const emptyTeamIssues: TeamIssue[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Cognito 認証後に表示するタスク専用ページです。
 */
export function TaskPage() {
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
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(currentUserKey, ([, accessToken]) => getCurrentUser(accessToken), apiSWRConfig)
  const inboxCount = useUnreadNotificationCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const workspaceAccessKey = accessToken && user && !currentUserError
    ? (['workspace-access', accessToken] as const)
    : null
  const { data: workspaceAccess } = useSWR(
    workspaceAccessKey,
    ([, token]) => getWorkspaceAccess(token),
    apiSWRConfig,
  )
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const { data: teams = [], mutate: mutateProjectDirectory } = useSWR(
    projectDirectoryKey,
    ([, accessToken, currentLocale]) =>
      getProjectDirectory(accessToken, currentLocale),
    apiSWRConfig,
  )
  const projectTasksKey = accessToken && user && !currentUserError
    ? (['project-tasks', accessToken, projectId] as const)
    : null
  const {
    data: projectIssues = emptyTeamIssues,
    error: taskError,
    isLoading: isProjectTasksLoading,
    mutate: mutateProjectTasks,
  } = useSWR(
    projectTasksKey,
    ([, accessToken, currentProjectId]) =>
      getProjectIssues(currentProjectId, accessToken).catch((error: unknown) => {
        throw normalizeProjectIssueError(error)
      }),
    apiSWRConfig,
  )
  const tasks = projectIssues
  const projectMembersKey = accessToken && user && !currentUserError
    ? (['project-members', accessToken, projectId] as const)
    : null
  const {
    data: projectMembersData,
    error: projectMembersError,
    isLoading: isProjectMembersLoading,
    mutate: mutateProjectMembers,
  } = useSWR(
    projectMembersKey,
    ([, accessToken, currentProjectId]) =>
      getProjectMembers(accessToken, currentProjectId),
    apiSWRConfig,
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
  const projectUsersKey =
    accessToken && user && projectId && !currentUserError && canManageProjectMembers
      ? (['project-users', accessToken, projectId, projectUserQuery] as const)
      : null
  const {
    data: projectUsersFirstPage,
    error: projectUsersError,
    isLoading: isProjectUsersLoading,
  } = useSWR(
    projectUsersKey,
    ([, accessToken, currentProjectId, currentQuery]) =>
      getProjectUsers(accessToken, currentProjectId, {
        limit: 20,
        query: currentQuery,
      }),
    apiSWRConfig,
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
  const activeTeam = findTeamForProject(teams, projectId, selectedTeamId)
  const activeProject = findProjectInTeams(teams, projectId, activeTeam?.id ?? selectedTeamId)
  const resolvedSelectedIssue =
    findIssueBySelection(projectIssues, selectedIssueId, selectedTeamId) ??
    projectIssues.find((issue) => selectedTeamId ? issue.teamId === selectedTeamId : false) ??
    projectIssues[0]
  const resolvedSelectedIssueTeamId = resolvedSelectedIssue?.teamId ?? activeTeam?.id
  const collaboration = useIssueCollaboration({
    accessToken,
    enabled: resolvedSelectedIssue?.source !== 'legacy',
    issueId: resolvedSelectedIssue?.id,
    projectId: resolvedSelectedIssue?.assignedProjectId ?? projectId,
    teamId: resolvedSelectedIssueTeamId,
  })
  const issueDetailKey = accessToken && resolvedSelectedIssue?.id && resolvedSelectedIssueTeamId
    ? (['project-issue-detail', accessToken, resolvedSelectedIssueTeamId, resolvedSelectedIssue.id] as const)
    : null
  const {
    data: selectedIssueDetail,
    error: detailError,
    isLoading: isSelectedIssueDetailLoading,
    mutate: mutateSelectedIssueDetail,
  } = useSWR(
    issueDetailKey,
    ([, token, teamId, issueId]) => getTeamIssueDetail(teamId, issueId, token),
    apiSWRConfig,
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
  const taskErrorMessage = useMemo(() => {
    if (!taskError) {
      return undefined
    }

    const message = taskError instanceof Error ? taskError.message : 'tasks.error.loading'

    return message === 'tasks.error.loading' ? t('tasks.error.loading') : message
  }, [taskError, t])
  const detailErrorMessage = issueUpdateErrorMessage ?? (
    detailError ? t('tasks.detail.error') : undefined
  )
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectTasksLoading)

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
    if (currentUserError) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [currentUserError, navigate])

  useEffect(() => {
    if (!isCreateTaskRequested) {
      return
    }

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('create')
    setSearchParams(nextSearchParams, { replace: true })
  }, [isCreateTaskRequested, searchParams, setSearchParams])

  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'

  const handleCreateTask = async (input: CreateProjectTaskInput) => {
    if (!accessToken) {
      return
    }

    if (!activeTeam) {
      throw new Error(t('issues.error.create'))
    }

    const issue = await mutationRequestRunner.run(
      'issue:create',
      JSON.stringify([activeTeam.id, projectId, input]),
      (context) => createTeamIssue(
        activeTeam.id,
        accessToken,
        {
          ...input,
          assignedProjectId: projectId,
        },
        context,
      ),
    )
    await mutateProjectTasks()
    navigate(createProjectIssuesPath(projectId, activeTeam.id, issue.id))
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
      console.error('Failed to create project:', error)
      throw error
    }
  }

  const handleArchiveTeam = async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run('team:archive', teamId, (context) =>
      archiveProjectDirectoryTeam(accessToken, teamId, context),
    )
    await mutateProjectDirectory()

    if (activeTeam?.id === teamId) {
      navigate(workspaceNavPaths.dashboard)
    }
  }

  const handleArchiveProject = async (teamId: string, archivedProjectId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([teamId, archivedProjectId]),
      (context) => archiveProjectDirectoryProject(
        accessToken,
        teamId,
        archivedProjectId,
        context,
      ),
    )
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

    await mutationRequestRunner.run(
      `member:update:${currentProjectId}:${memberKey}`,
      JSON.stringify(input),
      (context) => updateProjectMember(accessToken, currentProjectId, memberKey, input, context),
    )
    await mutateProjectMembers()
  }

  const handleRemoveProjectMember = async (currentProjectId: string, memberKey: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      `member:remove:${currentProjectId}:${memberKey}`,
      memberKey,
      (context) => removeProjectMember(accessToken, currentProjectId, memberKey, context),
    )
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
    const response = await getProjectUsers(accessToken, projectId, {
      limit: 20,
      nextToken: projectUsersNextToken,
      query: projectUserQuery,
    })

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
      : projectIssues.find((issue) => issue.id === issueId && issue.teamId === teamId)

    if (!currentIssue || currentIssue.source === 'legacy') {
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
      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        setIssueUpdateError([currentIssueUpdateErrorKey, t('tasks.detail.conflict')])
        await Promise.all([mutateProjectTasks(), mutateSelectedIssueDetail()])
      } else {
        setIssueUpdateError([currentIssueUpdateErrorKey, t('tasks.detail.error')])
      }

      throw error
    }
  }

  return (
    <TaskScreen
      isLoading={isLoading}
      locale={locale}
      activeProjectTeamId={activeTeam?.id}
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
      onCreateTask={canMutateContent ? handleCreateTask : undefined}
      assigneeErrorMessage={projectMembersErrorMessage}
      assigneeOptions={activeProjectMembers}
      canManageProjectMembers={canManageProjectMembers}
      collaboration={collaboration}
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
      onSelectedIssueChange={handleSelectedIssueChange}
      onUpdateIssue={canMutateContent ? handleUpdateIssue : undefined}
      onUpdateProjectMember={canManageProjectMembers ? handleUpdateProjectMember : undefined}
      projectId={projectId}
      projectMembers={projectMembers}
      projectMembersErrorMessage={projectPermissionsErrorMessage}
      projectName={projectName}
      projectUserQuery={projectUserQuery}
      projectUsers={projectUsers}
      projectUsersErrorMessage={projectUsersErrorMessage}
      projectUsersNextToken={projectUsersNextToken}
      selectedIssueDetail={selectedIssueDetail}
      taskErrorMessage={taskErrorMessage}
      tasks={tasks}
      teamName={activeTeam?.name}
      teams={teams}
      userInitial={userInitial}
      workspaceMembers={workspaceAccess?.members ?? emptyWorkspaceMembers}
    />
  )
}
function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}

function createProjectUsersPageKey(projectId: string, query: string) {
  return `${projectId}\u0000${query.trim()}`
}

function mergeProjectUsers(currentUsers: ProjectUser[], nextUsers: ProjectUser[]) {
  const usersById = new Map(currentUsers.map((user) => [user.id, user]))

  for (const user of nextUsers) {
    usersById.set(user.id, user)
  }

  return Array.from(usersById.values())
}

function normalizeProjectIssueError(error: unknown) {
  if (error instanceof TeamIssuesApiError && error.message === 'issues.error.loading') {
    return new ProjectTasksApiError(error.status, 'tasks.error.loading')
  }

  return error
}
