import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import useSWR from 'swr'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  getCurrentUser,
} from '../auth/api'
import { clearAuthSession, getAuthSession, type AuthSession } from '../auth/session'
import { createMutationRequestRunner } from '../api/mutationHeaders'
import {
  createTranslator,
  getInitialLocale,
  setLocalePreference,
  type Locale,
} from '../i18n'
import {
  useNotificationInbox,
  useNotificationPreferences,
  useUnreadNotificationCount,
} from '../notifications/useNotifications'
import {
  getWorkspaceWorkItems,
  TeamIssuesApiError,
} from '../issues/api'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../projects/api'
import { resolveNotificationPath } from '../notifications/paths'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  getInitialFontSizePreference,
  setFontSizePreference as saveFontSizePreference,
  type FontSizePreference,
} from '../preferences/fontSize'
import type { ProjectTask, TaskStatus } from '../tasks/api'
import {
  WorkspaceScreen,
  type TeamProjectMemberAccess,
  type WorkspaceView,
} from '../workspace'
import { workspaceData } from '../workspace/workspaceData'
import { workspacePresentation } from '../workspace/workspacePresentation'
import { workspaceViewMetadata } from '../workspace/workspaceViewMetadata'

/**
 * Storybook と画面テストから利用する Workspace の表示コンポーネントです。
 */
export { WorkspaceScreen }

/**
 * サイドバーまたはチーム配下から表示できるワークスペース画面です。
 */
export type { WorkspaceView }

/**
 * WorkspacePage が描画する画面種別を受け取る props です。
 */
type WorkspacePageProps = {
  /**
   * URL に対応するワークスペース画面種別です。
   */
  view: WorkspaceView
}

const emptyProjectDirectory: ProjectDirectoryTeam[] = []
const emptyProjectTasks: ProjectTask[] = []
const emptyProjectTaskFailures: string[] = []
const emptyTeamProjectMembers: TeamProjectMemberAccess[] = []
const emptyTeamProjectMemberFailures: string[] = []

const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * 認証済みワークスペースの固定ナビゲーション画面です。
 */
export function WorkspacePage({ view }: WorkspacePageProps) {
  const navigate = useNavigate()
  const params = useParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const [fontSizePreference, setFontSizePreferenceState] = useState<FontSizePreference>(() =>
    getInitialFontSizePreference(),
  )
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const notificationInbox = useNotificationInbox(accessToken, view === 'inbox')
  const notificationPreferences = useNotificationPreferences(accessToken, view === 'settings')
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(currentUserKey, ([, currentAccessToken]) => getCurrentUser(currentAccessToken), apiSWRConfig)
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const {
    data: teams = emptyProjectDirectory,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useSWR(
    projectDirectoryKey,
    ([, currentAccessToken, currentLocale]) =>
      getProjectDirectory(currentAccessToken, currentLocale),
    apiSWRConfig,
  )
  const projectIds = useMemo(() => workspacePresentation.uniqueProjectIds(teams), [teams])
  const activeTeam = useMemo(
    () => workspacePresentation.findActiveTeam(teams, params.teamId),
    [params.teamId, teams],
  )
  const activeTeamProjects = activeTeam?.projects ?? []
  const isTeamManagementView = view === 'team-overview' || view === 'team-members'
  const needsWorkspaceWorkItems = !['help', 'inbox', 'settings'].includes(view)
  const workspaceWorkItemsKey =
    accessToken && user && !currentUserError && needsWorkspaceWorkItems
      ? (['workspace-work-items', accessToken] as const)
      : null
  const {
    data: tasks = emptyProjectTasks,
    error: workspaceWorkItemsError,
    isLoading: isWorkspaceWorkItemsLoading,
    mutate: mutateWorkspaceWorkItems,
  } = useSWR(
    workspaceWorkItemsKey,
    ([, currentAccessToken]) => getWorkspaceWorkItems(currentAccessToken),
    apiSWRConfig,
  )
  const taskLoadFailedProjectIds = workspaceWorkItemsError
    ? projectIds
    : emptyProjectTaskFailures
  const teamProjectMembersKey =
    accessToken && user && !currentUserError && isTeamManagementView && activeTeamProjects.length > 0
      ? ([
          'workspace-team-project-members',
          accessToken,
          activeTeam?.id,
          activeTeamProjects.map((project) => project.id).join('\0'),
        ] as const)
      : null
  const {
    data: teamProjectMembersResult,
    isLoading: isTeamProjectMembersLoading,
  } = useSWR(
    teamProjectMembersKey,
    ([, currentAccessToken]) =>
      workspaceData.loadTeamProjectMembers(currentAccessToken, activeTeamProjects),
    apiSWRConfig,
  )
  const [taskMoveErrorMessage, setTaskMoveErrorMessage] = useState<string | undefined>()
  const pendingTaskMoveKeysRef = useRef(new Set<string>())
  const summary = useMemo(
    () => workspacePresentation.createDashboardSummary(teams, tasks),
    [tasks, teams],
  )
  const metadata = workspaceViewMetadata[view]
  const title = workspacePresentation.formatTeamText(
    t(metadata.titleKey),
    activeTeam?.name ?? t('workspace.team.missing'),
  )
  const userLabel =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userIdentityAliases = useMemo(
    () => [user?.username, user?.attributes.email, user?.attributes.sub]
      .filter((value): value is string => Boolean(value)),
    [user],
  )
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const inboxCount = useUnreadNotificationCount(
    accessToken,
    Boolean(user && !currentUserError),
  )
  const canManageStructure = canManageWorkspaceStructure(user)
  const canMutateContent = canMutateWorkspaceContent(user)
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && workspaceWorkItemsKey && isWorkspaceWorkItemsLoading)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${title} | ${t('app.title')}`
  }, [locale, t, title])

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

  const handleLogout = () => {
    clearAuthSession()
    navigate('/', { replace: true })
  }

  const handleFontSizePreferenceChange = (preference: FontSizePreference) => {
    setFontSizePreferenceState(preference)
    saveFontSizePreference(preference)
  }

  const handleLocaleChange = (nextLocale: Locale) => {
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }

  const handleCreateTeam = async (input: CreateProjectDirectoryTeamInput) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run('team:create', JSON.stringify(input), (context) =>
      createProjectDirectoryTeam(accessToken, input, context),
    )
    await mutateProjectDirectory()
  }

  const handleCreateProject = async (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      'project:create',
      JSON.stringify([teamId, input]),
      (context) => createProjectDirectoryProject(accessToken, teamId, input, context),
    )
    await mutateProjectDirectory()
  }

  const handleArchiveTeam = async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run('team:archive', teamId, (context) =>
      archiveProjectDirectoryTeam(accessToken, teamId, context),
    )
    await mutateProjectDirectory()

    if (params.teamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }

  const handleArchiveProject = async (teamId: string, projectId: string) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([teamId, projectId]),
      (context) => archiveProjectDirectoryProject(accessToken, teamId, projectId, context),
    )
    await mutateProjectDirectory()
  }

  const handleMoveTaskStatus = async (task: ProjectTask, status: TaskStatus) => {
    if (!accessToken || task.status === status || workspacePresentation.isLegacyWorkspaceTask(task)) {
      return
    }

    setTaskMoveErrorMessage(undefined)
    const taskKey = workspacePresentation.createWorkspaceTaskKey(task)
    if (pendingTaskMoveKeysRef.current.has(taskKey)) {
      return
    }

    pendingTaskMoveKeysRef.current.add(taskKey)
    const nextTasks = workspacePresentation.updateWorkspaceTaskStatus(
      tasks,
      task,
      status,
      task.status,
    )

    try {
      await mutateWorkspaceWorkItems(
        (currentTasks = tasks) =>
          workspacePresentation.updateWorkspaceTaskStatus(
            currentTasks,
            task,
            status,
            task.status,
          ),
        { revalidate: false },
      )
      const updatedTask = await mutationRequestRunner.run(
        `task:status:${taskKey}`,
        JSON.stringify([task.revision, status]),
        (context) => workspaceData.updateWorkspaceTaskRemote(
          task,
          accessToken,
          status,
          context,
        ),
      )
      await mutateWorkspaceWorkItems(
        (currentTasks = nextTasks) =>
          workspacePresentation.replaceWorkspaceTask(currentTasks, updatedTask),
        {
          revalidate: false,
        },
      )
    } catch (error) {
      await mutateWorkspaceWorkItems(
        (currentTasks = nextTasks) =>
          workspacePresentation.updateWorkspaceTaskStatus(
            currentTasks,
            task,
            task.status,
            status,
          ),
        { revalidate: false },
      )

      if (error instanceof TeamIssuesApiError && error.code === 'WorkItemRevisionConflict') {
        setTaskMoveErrorMessage(t('workspace.myTasks.conflict'))
        await mutateWorkspaceWorkItems()
      } else {
        setTaskMoveErrorMessage(t('workspace.myTasks.moveError'))
      }

      throw error
    } finally {
      pendingTaskMoveKeysRef.current.delete(taskKey)
    }
  }

  return (
    <WorkspaceScreen
      accessToken={accessToken}
      activeTeamId={params.teamId}
      fontSizePreference={fontSizePreference}
      inboxCount={inboxCount}
      isLoading={isLoading}
      isTeamProjectMembersLoading={Boolean(teamProjectMembersKey && isTeamProjectMembersLoading)}
      locale={locale}
      notificationInbox={notificationInbox}
      notificationPreferences={notificationPreferences}
      onFontSizePreferenceChange={handleFontSizePreferenceChange}
      onLocaleChange={handleLocaleChange}
      onLogout={handleLogout}
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectProject={(projectId, teamId) =>
        navigate(createProjectIssuesPath(projectId, teamId))
      }
      onSelectTeamView={(teamId, viewId) =>
        navigate(createTeamViewPath(teamId, viewId))
      }
      onCreateProject={canManageStructure ? handleCreateProject : undefined}
      onCreateTeam={canManageStructure ? handleCreateTeam : undefined}
      onArchiveProject={canManageStructure ? handleArchiveProject : undefined}
      onArchiveTeam={canManageStructure ? handleArchiveTeam : undefined}
      onMoveTaskStatus={canMutateContent ? handleMoveTaskStatus : undefined}
      onOpenTask={(task) => {
        if (!task.teamId) {
          return
        }

        navigate(
          task.assignedProjectId
            ? createProjectIssuesPath(task.assignedProjectId, task.teamId, task.id)
            : createTeamIssuesPath(task.teamId, task.id),
        )
      }}
      onOpenNotification={(notification) => {
        const path = resolveNotificationPath(notification)

        if (path) {
          navigate(path)
        }
      }}
      summary={summary}
      taskMoveErrorMessage={taskMoveErrorMessage}
      taskLoadFailedProjectIds={taskLoadFailedProjectIds}
      tasks={tasks}
      teamProjectMembers={teamProjectMembersResult?.members ?? emptyTeamProjectMembers}
      teamProjectMembersFailedProjectIds={
        teamProjectMembersResult?.failedProjectIds ?? emptyTeamProjectMemberFailures
      }
      teams={teams}
      userIdentityAliases={userIdentityAliases}
      userInitial={userInitial}
      userLabel={userLabel}
      view={view}
    />
  )
}
