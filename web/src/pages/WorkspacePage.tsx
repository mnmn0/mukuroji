import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import useSWR from 'swr'
import {
  getCurrentUser,
  type DashboardSummary,
} from '../auth/api'
import { clearAuthSession, getAuthSession, type AuthSession } from '../auth/session'
import {
  MobileSidebarButton,
  MobileSidebarDrawer,
  Sidebar,
  type SidebarNavId,
  type SidebarTeamViewId,
} from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../i18n'
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
  removeProjectMember,
  type ProjectMember,
  type ProjectMemberRole,
  type ProjectUser,
  type ProjectDirectoryTeam,
  type UpdateProjectMemberInput,
  updateProjectMember,
} from '../projects/api'
import {
  createProjectTasksPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  getProjectTasks,
  type ProjectTask,
  type TaskPriority,
  type TaskStatus,
  updateProjectTaskStatus,
} from '../tasks/api'

/**
 * サイドバーまたはチーム配下から表示できるワークスペース画面です。
 */
export type WorkspaceView =
  | 'home'
  | 'my-tasks'
  | 'inbox'
  | 'dashboard'
  | 'reports'
  | 'permissions'
  | 'help'
  | 'settings'
  | 'team-overview'
  | 'team-members'

/**
 * WorkspacePage が描画する画面種別を受け取る props です。
 */
type WorkspacePageProps = {
  /**
   * URL に対応するワークスペース画面種別です。
   */
  view: WorkspaceView
}

/**
 * WorkspaceScreen に渡す描画済みのアプリ状態です。
 */
type WorkspaceScreenProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のワークスペース画面種別です。
   */
  view: WorkspaceView
  /**
   * ヘッダーに表示するユーザー名です。
   */
  userLabel: string
  /**
   * ユーザーアバターに表示する頭文字です。
   */
  userInitial: string
  /**
   * ダッシュボード集計値です。
   */
  summary: DashboardSummary
  /**
   * サイドバーとチーム画面に表示するチーム/プロジェクト階層です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * チーム画面で選択中のチーム ID です。
   */
  activeTeamId?: string
  /**
   * 表示に使うタスク一覧です。
   */
  tasks: ProjectTask[]
  /**
   * 権限管理で選択中の project ID です。
   */
  selectedPermissionProjectId?: string
  /**
   * 権限管理画面に表示する project member 一覧です。
   */
  projectMembers: ProjectMember[]
  /**
   * 権限管理画面で選択できる Cognito user 候補です。
   */
  projectUsers: ProjectUser[]
  /**
   * 権限管理の member 一覧を読み込み中かどうかです。
   */
  isProjectMembersLoading?: boolean
  /**
   * 権限管理の Cognito user 候補を読み込み中かどうかです。
   */
  isProjectUsersLoading?: boolean
  /**
   * 権限管理の API エラー表示です。
   */
  projectMembersErrorMessage?: string
  /**
   * 権限管理の Cognito user 候補取得エラー表示です。
   */
  projectUsersErrorMessage?: string
  /**
   * Cognito user 一覧の次 page token です。
   */
  projectUsersNextToken?: string
  /**
   * Cognito user 検索 query です。
   */
  projectUserQuery: string
  /**
   * システム管理者として扱われるログインユーザーかどうかです。
   */
  isSystemAdmin?: boolean
  /**
   * 認証または API 確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * ログアウト操作の callback です。
   */
  onLogout?: () => void
  /**
   * サイドバーの固定ナビが選択されたときの callback です。
   */
  onSelectNav?: (navId: SidebarNavId) => void
  /**
   * サイドバーのチーム固定ビューが選択されたときの callback です。
   */
  onSelectTeamView?: (teamId: string, viewId: SidebarTeamViewId) => void
  /**
   * サイドバーのプロジェクトが選択されたときの callback です。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
  /**
   * チーム新規登録時の callback です。
   */
  onCreateTeam?: (input: CreateProjectDirectoryTeamInput) => Promise<void>
  /**
   * プロジェクト新規登録時の callback です。
   */
  onCreateProject?: (teamId: string, input: CreateProjectDirectoryProjectInput) => Promise<void>
  /**
   * チームアーカイブ時の callback です。
   */
  onArchiveTeam?: (teamId: string) => Promise<void>
  /**
   * プロジェクトアーカイブ時の callback です。
   */
  onArchiveProject?: (teamId: string, projectId: string) => Promise<void>
  /**
   * 権限管理で対象 project を切り替えたときの callback です。
   */
  onSelectPermissionProject?: (projectId: string) => void
  /**
   * 権限管理の Cognito user 検索 query 変更 callback です。
   */
  onProjectUserQueryChange?: (query: string) => void
  /**
   * Cognito user 一覧の次 page 読み込み callback です。
   */
  onLoadMoreProjectUsers?: () => Promise<void>
  /**
   * project member role 保存時の callback です。
   */
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
  /**
   * project member role 削除時の callback です。
   */
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  /**
   * マイタスクの状態列を移動したときの callback です。
   */
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
  /**
   * マイタスク状態更新に失敗したときの表示メッセージです。
   */
  taskMoveErrorMessage?: string
}

/**
 * ワークスペース画面ごとのタイトル情報です。
 */
type WorkspaceViewMetadata = {
  /**
   * サイドバーの固定ナビを active にする ID です。
   */
  activeNavId?: SidebarNavId
  /**
   * チーム固定ビューを active にする ID です。
   */
  activeTeamViewId?: SidebarTeamViewId
  /**
   * 画面上部の補助ラベルを解決する i18n key です。
   */
  eyebrowKey: MessageKey
  /**
   * 画面タイトルを解決する i18n key です。
   */
  titleKey: MessageKey
  /**
   * 画面説明を解決する i18n key です。
   */
  descriptionKey: MessageKey
}

/**
 * 権限管理で選択できる project option です。
 */
type PermissionProjectOption = {
  /**
   * project ID です。
   */
  id: string
  /**
   * project 表示名です。
   */
  name: string
  /**
   * 所属チーム表示名です。
   */
  teamName: string
}

/**
 * PermissionsView が受け取る props です。
 */
type PermissionsViewProps = {
  /**
   * 権限 API のエラーメッセージです。
   */
  errorMessage?: string
  /**
   * member 一覧を読み込み中かどうかです。
   */
  isLoading?: boolean
  /**
   * Cognito user 候補を読み込み中かどうかです。
   */
  isUsersLoading?: boolean
  /**
   * ログインユーザーがシステム管理者かどうかです。
   */
  isSystemAdmin?: boolean
  /**
   * 選択中 project の member 一覧です。
   */
  members: ProjectMember[]
  /**
   * 選択可能な Cognito user 候補です。
   */
  users: ProjectUser[]
  /**
   * 選択可能な project 一覧です。
   */
  projects: PermissionProjectOption[]
  /**
   * 選択中の project ID です。
   */
  selectedProjectId?: string
  /**
   * Cognito user 一覧の次 page token です。
   */
  usersNextToken?: string
  /**
   * Cognito user 検索 query です。
   */
  userQuery: string
  /**
   * Cognito user 候補取得エラーです。
   */
  usersErrorMessage?: string
  /**
   * i18n message 解決関数です。
   */
  t: (key: MessageKey) => string
  /**
   * member role 削除 callback です。
   */
  onRemoveMember?: (projectId: string, memberKey: string) => Promise<void>
  /**
   * project 選択 callback です。
   */
  onSelectProject?: (projectId: string) => void
  /**
   * Cognito user 一覧の次 page 読み込み callback です。
   */
  onLoadMoreUsers?: () => Promise<void>
  /**
   * Cognito user 検索 query 変更 callback です。
   */
  onUserQueryChange?: (query: string) => void
  /**
   * member role 保存 callback です。
   */
  onUpdateMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
}

/**
 * 権限管理フォームの入力状態です。
 */
type ProjectMemberFormState = {
  /**
   * 選択中の Cognito user ID です。
   */
  userId: string
  /**
   * 付与するプロジェクトロールです。
   */
  role: ProjectMemberRole
}

/**
 * RoleSelect が受け取る props です。
 */
type RoleSelectProps = {
  /**
   * select の id 属性です。
   */
  id: string
  /**
   * select に表示するラベルです。
   */
  label: string
  /**
   * i18n message 解決関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Playwright で参照する test id です。
   */
  testId?: string
  /**
   * 選択中の project member role です。
   */
  value: ProjectMemberRole
  /**
   * role 変更 callback です。
   */
  onChange: (role: ProjectMemberRole) => void
}

const emptyProjectDirectory: ProjectDirectoryTeam[] = []
const emptyProjectMembers: ProjectMember[] = []
const emptyProjectUsers: ProjectUser[] = []
const emptyProjectTasks: ProjectTask[] = []
const myTaskKanbanStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]
const projectMemberRoleOptions = ['manager', 'member', 'viewer'] as const satisfies readonly ProjectMemberRole[]

const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

const workspaceViewMetadata: Record<WorkspaceView, WorkspaceViewMetadata> = {
  home: {
    activeNavId: 'home',
    eyebrowKey: 'workspace.home.eyebrow',
    titleKey: 'workspace.home.title',
    descriptionKey: 'workspace.home.description',
  },
  'my-tasks': {
    activeNavId: 'my-tasks',
    eyebrowKey: 'workspace.myTasks.eyebrow',
    titleKey: 'workspace.myTasks.title',
    descriptionKey: 'workspace.myTasks.description',
  },
  inbox: {
    activeNavId: 'inbox',
    eyebrowKey: 'workspace.inbox.eyebrow',
    titleKey: 'workspace.inbox.title',
    descriptionKey: 'workspace.inbox.description',
  },
  dashboard: {
    activeNavId: 'dashboard',
    eyebrowKey: 'workspace.dashboard.eyebrow',
    titleKey: 'workspace.dashboard.title',
    descriptionKey: 'workspace.dashboard.description',
  },
  reports: {
    activeNavId: 'reports',
    eyebrowKey: 'workspace.reports.eyebrow',
    titleKey: 'workspace.reports.title',
    descriptionKey: 'workspace.reports.description',
  },
  permissions: {
    activeNavId: 'permissions',
    eyebrowKey: 'workspace.permissions.eyebrow',
    titleKey: 'workspace.permissions.title',
    descriptionKey: 'workspace.permissions.description',
  },
  help: {
    activeNavId: 'help',
    eyebrowKey: 'workspace.help.eyebrow',
    titleKey: 'workspace.help.title',
    descriptionKey: 'workspace.help.description',
  },
  settings: {
    activeNavId: 'settings',
    eyebrowKey: 'workspace.settings.eyebrow',
    titleKey: 'workspace.settings.title',
    descriptionKey: 'workspace.settings.description',
  },
  'team-overview': {
    activeTeamViewId: 'overview',
    eyebrowKey: 'workspace.teamOverview.eyebrow',
    titleKey: 'workspace.teamOverview.title',
    descriptionKey: 'workspace.teamOverview.description',
  },
  'team-members': {
    activeTeamViewId: 'members',
    eyebrowKey: 'workspace.teamMembers.eyebrow',
    titleKey: 'workspace.teamMembers.title',
    descriptionKey: 'workspace.teamMembers.description',
  },
}

/**
 * 認証済みワークスペースの固定ナビゲーション画面です。
 */
export function WorkspacePage({ view }: WorkspacePageProps) {
  const navigate = useNavigate()
  const params = useParams()
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [selectedPermissionProjectId, setSelectedPermissionProjectId] = useState<string | undefined>()
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
  const projectIds = useMemo(() => uniqueProjectIds(teams), [teams])
  const permissionProjectId = selectedPermissionProjectId && projectIds.includes(selectedPermissionProjectId)
    ? selectedPermissionProjectId
    : projectIds[0]
  const projectMembersKey =
    accessToken && user && !currentUserError && permissionProjectId
      ? (['project-members', accessToken, permissionProjectId] as const)
      : null
  const {
    data: projectMembers = emptyProjectMembers,
    error: projectMembersError,
    isLoading: isProjectMembersLoading,
    mutate: mutateProjectMembers,
  } = useSWR(
    projectMembersKey,
    ([, currentAccessToken, currentProjectId]) =>
      getProjectMembers(currentAccessToken, currentProjectId),
    apiSWRConfig,
  )
  const projectUsersKey =
    accessToken && user && !currentUserError && permissionProjectId
      ? (['project-users', accessToken, permissionProjectId, projectUserQuery] as const)
      : null
  const {
    data: projectUsersFirstPage,
    error: projectUsersError,
    isLoading: isProjectUsersLoading,
  } = useSWR(
    projectUsersKey,
    ([, currentAccessToken, currentProjectId, currentQuery]) =>
      getProjectUsers(currentAccessToken, currentProjectId, {
        limit: 20,
        query: currentQuery,
      }),
    apiSWRConfig,
  )
  const projectTasksKey =
    accessToken && user && !currentUserError && projectIds.length > 0
      ? (['workspace-project-tasks', accessToken, projectIds] as const)
      : null
  const {
    data: tasks = emptyProjectTasks,
    isLoading: isProjectTasksLoading,
    mutate: mutateProjectTasks,
  } = useSWR(
    projectTasksKey,
    ([, currentAccessToken, currentProjectIds]) =>
      loadProjectTasks(currentProjectIds, currentAccessToken),
    apiSWRConfig,
  )
  const [taskMoveErrorMessage, setTaskMoveErrorMessage] = useState<string | undefined>()
  const pendingTaskMoveKeysRef = useRef(new Set<string>())
  const projectUsersPageKey = createProjectUsersPageKey(permissionProjectId, projectUserQuery)
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
  const summary = useMemo(() => createDashboardSummary(teams, tasks), [tasks, teams])
  const metadata = workspaceViewMetadata[view]
  const title = t(metadata.titleKey)
  const userLabel =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && projectIds.length > 0 && isProjectTasksLoading)

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

  const handleCreateTeam = async (input: CreateProjectDirectoryTeamInput) => {
    if (!accessToken) {
      return
    }

    await createProjectDirectoryTeam(accessToken, input)
    await mutateProjectDirectory()
  }

  const handleCreateProject = async (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await createProjectDirectoryProject(accessToken, teamId, input)
    await mutateProjectDirectory()
  }

  const handleArchiveTeam = async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await archiveProjectDirectoryTeam(accessToken, teamId)
    await mutateProjectDirectory()

    if (params.teamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }

  const handleArchiveProject = async (teamId: string, projectId: string) => {
    if (!accessToken) {
      return
    }

    await archiveProjectDirectoryProject(accessToken, teamId, projectId)
    await mutateProjectDirectory()
  }

  const handleUpdateProjectMember = async (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => {
    if (!accessToken) {
      return
    }

    await updateProjectMember(accessToken, projectId, memberKey, input)
    await mutateProjectMembers()
  }

  const handleRemoveProjectMember = async (projectId: string, memberKey: string) => {
    if (!accessToken) {
      return
    }

    await removeProjectMember(accessToken, projectId, memberKey)
    await mutateProjectMembers()
  }

  const handleLoadMoreProjectUsers = async () => {
    if (!accessToken || !permissionProjectId || !projectUsersNextToken) {
      return
    }

    const currentPageKey = createProjectUsersPageKey(permissionProjectId, projectUserQuery)
    const currentExtraUsers = projectUsersExtraPage?.key === currentPageKey
      ? projectUsersExtraPage.users
      : emptyProjectUsers
    const response = await getProjectUsers(accessToken, permissionProjectId, {
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

  const handleMoveTaskStatus = async (task: ProjectTask, status: TaskStatus) => {
    if (!accessToken || !task.projectId || task.status === status) {
      return
    }

    setTaskMoveErrorMessage(undefined)
    const taskKey = createWorkspaceTaskKey(task)
    if (pendingTaskMoveKeysRef.current.has(taskKey)) {
      return
    }

    pendingTaskMoveKeysRef.current.add(taskKey)
    const nextTasks = updateWorkspaceTaskStatus(tasks, task, status, task.status)

    try {
      await mutateProjectTasks(
        (currentTasks = tasks) =>
          updateWorkspaceTaskStatus(currentTasks, task, status, task.status),
        { revalidate: false },
      )
      const updatedTask = await updateProjectTaskStatus(task.projectId, task.id, accessToken, status)
      await mutateProjectTasks(
        (currentTasks = nextTasks) =>
          replaceWorkspaceTask(currentTasks, updatedTask),
        {
          revalidate: false,
        },
      )
    } catch (error) {
      await mutateProjectTasks(
        (currentTasks = nextTasks) =>
          updateWorkspaceTaskStatus(currentTasks, task, task.status),
        { revalidate: false },
      )
      setTaskMoveErrorMessage(t('workspace.myTasks.moveError'))
      throw error
    } finally {
      pendingTaskMoveKeysRef.current.delete(taskKey)
    }
  }

  return (
    <WorkspaceScreen
      activeTeamId={params.teamId}
      isLoading={isLoading}
      locale={locale}
      onLogout={handleLogout}
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectProject={(projectId, teamId) =>
        navigate(createProjectTasksPath(projectId, teamId))
      }
      onSelectTeamView={(teamId, viewId) =>
        navigate(createTeamViewPath(teamId, viewId))
      }
      onCreateProject={handleCreateProject}
      onCreateTeam={handleCreateTeam}
      onArchiveProject={handleArchiveProject}
      onArchiveTeam={handleArchiveTeam}
      onRemoveProjectMember={handleRemoveProjectMember}
      onMoveTaskStatus={handleMoveTaskStatus}
      onLoadMoreProjectUsers={handleLoadMoreProjectUsers}
      onProjectUserQueryChange={setProjectUserQuery}
      onSelectPermissionProject={setSelectedPermissionProjectId}
      onUpdateProjectMember={handleUpdateProjectMember}
      isProjectMembersLoading={isProjectMembersLoading}
      isProjectUsersLoading={isProjectUsersLoading}
      isSystemAdmin={user?.isSystemAdmin}
      projectMembers={projectMembers}
      projectMembersErrorMessage={projectMembersError ? t('workspace.permissions.error') : undefined}
      projectUserQuery={projectUserQuery}
      projectUsers={projectUsers}
      projectUsersErrorMessage={projectUsersErrorMessage}
      projectUsersNextToken={projectUsersNextToken}
      selectedPermissionProjectId={permissionProjectId}
      summary={summary}
      taskMoveErrorMessage={taskMoveErrorMessage}
      tasks={tasks}
      teams={teams}
      userInitial={userInitial}
      userLabel={userLabel}
      view={view}
    />
  )
}

/**
 * 認証済みワークスペース UI を描画する Storybook 兼用 screen です。
 */
export function WorkspaceScreen({
  locale,
  view,
  userLabel,
  userInitial,
  summary,
  teams,
  activeTeamId,
  tasks,
  selectedPermissionProjectId,
  projectMembers,
  projectUsers,
  isProjectMembersLoading,
  isProjectUsersLoading,
  projectMembersErrorMessage,
  projectUsersErrorMessage,
  projectUsersNextToken,
  projectUserQuery,
  isSystemAdmin,
  isLoading = false,
  onLogout,
  onSelectNav,
  onSelectTeamView,
  onSelectProject,
  onCreateProject,
  onCreateTeam,
  onArchiveProject,
  onArchiveTeam,
  onSelectPermissionProject,
  onProjectUserQueryChange,
  onLoadMoreProjectUsers,
  onUpdateProjectMember,
  onRemoveProjectMember,
  onMoveTaskStatus,
  taskMoveErrorMessage,
}: WorkspaceScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const metadata = workspaceViewMetadata[view]
  const activeTeam = findActiveTeam(teams, activeTeamId)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  return (
    <main className="flex min-h-svh overflow-hidden bg-[#f5f8fc] text-[#0d1833]">
      <Sidebar
        activeNavId={metadata.activeNavId}
        activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
        activeTeamViewId={metadata.activeTeamViewId}
        className="max-[980px]:hidden"
        inboxCount={createInboxTasks(tasks).length}
        labels={sidebarLabels}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />

      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        dialogLabel={t('sidebar.mobileDialog')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeNavId={metadata.activeNavId}
          activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
          activeTeamViewId={metadata.activeTeamViewId}
          inboxCount={createInboxTasks(tasks).length}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            onSelectNav?.(navId)
          }}
          onSelectProject={(projectId, teamId) => {
            setIsMobileSidebarOpen(false)
            onSelectProject?.(projectId, teamId)
          }}
          onSelectTeamView={(teamId, viewId) => {
            setIsMobileSidebarOpen(false)
            onSelectTeamView?.(teamId, viewId)
          }}
          teams={teams}
        />
      </MobileSidebarDrawer>

      <section className="min-w-0 flex-1 overflow-auto">
        <header className="border-b border-slate-200 bg-white px-[clamp(22px,3vw,40px)] py-6">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-5">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={() => setIsMobileSidebarOpen(true)}
              />
              <div className="min-w-0">
                <p className="text-sm font-black uppercase tracking-normal text-blue-600">
                  {t(metadata.eyebrowKey)}
                </p>
                <h1 className="mt-3 text-[clamp(30px,3.2vw,46px)] font-black leading-tight text-[#0d1833]">
                  {formatTeamText(t(metadata.titleKey), activeTeam?.name)}
                </h1>
                <p className="mt-3 max-w-[760px] text-base font-bold leading-7 text-[#526381]">
                  {formatTeamText(t(metadata.descriptionKey), activeTeam?.name)}
                </p>
              </div>
            </div>

            <div className="flex flex-none items-center gap-3">
              <div className="hidden text-right max-[720px]:sr-only min-[721px]:block">
                <p className="text-xs font-black uppercase tracking-normal text-[#69758a]">
                  {t('workspace.user.label')}
                </p>
                <p className="mt-1 max-w-[220px] truncate text-sm font-black text-[#0d1833]">
                  {userLabel}
                </p>
              </div>
              <div className="grid h-11 w-11 place-items-center rounded-full bg-blue-100 text-sm font-black text-blue-700">
                {userInitial}
              </div>
              <button
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-black text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600"
                type="button"
                onClick={onLogout}
              >
                {t('dashboard.logout')}
              </button>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-[420px] place-items-center px-6 text-base font-bold text-[#526381]">
            {t('workspace.loading')}
          </div>
        ) : (
          <WorkspaceBody
            activeTeam={activeTeam}
            isProjectMembersLoading={isProjectMembersLoading}
            isProjectUsersLoading={isProjectUsersLoading}
            isSystemAdmin={isSystemAdmin}
            projectMembers={projectMembers}
            projectMembersErrorMessage={projectMembersErrorMessage}
            projectUserQuery={projectUserQuery}
            projectUsers={projectUsers}
            projectUsersErrorMessage={projectUsersErrorMessage}
            projectUsersNextToken={projectUsersNextToken}
            selectedPermissionProjectId={selectedPermissionProjectId}
            summary={summary}
            t={t}
            taskMoveErrorMessage={taskMoveErrorMessage}
            tasks={tasks}
            teams={teams}
            onRemoveProjectMember={onRemoveProjectMember}
            onLoadMoreProjectUsers={onLoadMoreProjectUsers}
            onSelectPermissionProject={onSelectPermissionProject}
            onProjectUserQueryChange={onProjectUserQueryChange}
            onUpdateProjectMember={onUpdateProjectMember}
            onMoveTaskStatus={onMoveTaskStatus}
            view={view}
          />
        )}
      </section>
    </main>
  )
}

function WorkspaceBody({
  activeTeam,
  isProjectMembersLoading,
  isProjectUsersLoading,
  isSystemAdmin,
  projectMembers,
  projectMembersErrorMessage,
  projectUserQuery,
  projectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  selectedPermissionProjectId,
  summary,
  t,
  taskMoveErrorMessage,
  tasks,
  teams,
  onLoadMoreProjectUsers,
  onRemoveProjectMember,
  onProjectUserQueryChange,
  onSelectPermissionProject,
  onUpdateProjectMember,
  onMoveTaskStatus,
  view,
}: {
  activeTeam?: ProjectDirectoryTeam
  isProjectMembersLoading?: boolean
  isProjectUsersLoading?: boolean
  isSystemAdmin?: boolean
  projectMembers: ProjectMember[]
  projectMembersErrorMessage?: string
  projectUserQuery: string
  projectUsers: ProjectUser[]
  projectUsersErrorMessage?: string
  projectUsersNextToken?: string
  selectedPermissionProjectId?: string
  summary: DashboardSummary
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  onLoadMoreProjectUsers?: () => Promise<void>
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  onProjectUserQueryChange?: (query: string) => void
  onSelectPermissionProject?: (projectId: string) => void
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
  view: WorkspaceView
}) {
  return (
    <div className="px-[clamp(22px,3vw,40px)] py-7">
      {view === 'home' ? <HomeView summary={summary} t={t} tasks={tasks} teams={teams} /> : null}
      {view === 'my-tasks' ? (
        <MyTasksView
          t={t}
          taskMoveErrorMessage={taskMoveErrorMessage}
          tasks={tasks}
          onMoveTaskStatus={onMoveTaskStatus}
        />
      ) : null}
      {view === 'inbox' ? <InboxView t={t} tasks={tasks} /> : null}
      {view === 'dashboard' ? (
        <DashboardWorkspaceView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
        />
      ) : null}
      {view === 'reports' ? <ReportsView summary={summary} t={t} tasks={tasks} /> : null}
      {view === 'permissions' ? (
        <PermissionsView
          errorMessage={projectMembersErrorMessage}
          isLoading={isProjectMembersLoading}
          isUsersLoading={isProjectUsersLoading}
          isSystemAdmin={isSystemAdmin}
          members={projectMembers}
          projects={createPermissionProjectOptions(teams)}
          selectedProjectId={selectedPermissionProjectId}
          t={t}
          users={projectUsers}
          usersErrorMessage={projectUsersErrorMessage}
          usersNextToken={projectUsersNextToken}
          userQuery={projectUserQuery}
          onLoadMoreUsers={onLoadMoreProjectUsers}
          onRemoveMember={onRemoveProjectMember}
          onSelectProject={onSelectPermissionProject}
          onUserQueryChange={onProjectUserQueryChange}
          onUpdateMember={onUpdateProjectMember}
        />
      ) : null}
      {view === 'help' ? <HelpView t={t} /> : null}
      {view === 'settings' ? <SettingsView t={t} /> : null}
      {view === 'team-overview' ? (
        <TeamOverviewView team={activeTeam} t={t} tasks={tasks} />
      ) : null}
      {view === 'team-members' ? <TeamMembersView team={activeTeam} t={t} tasks={tasks} /> : null}
    </div>
  )
}

function HomeView({
  summary,
  t,
  tasks,
  teams,
}: {
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const nextTasks = tasks.slice(0, 3)
  const activityTasks = createActivityTasks(tasks)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="blue" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.teams')} value={teams.length} tone="amber" />
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-6 max-[1080px]:grid-cols-1">
        <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
          <SectionHeader title={t('workspace.home.focusTitle')} meta={t('workspace.home.focusMeta')} />
          <div className="divide-y divide-slate-100">
            {nextTasks.map((task) => (
              <TaskListRow key={createWorkspaceTaskKey(task)} t={t} task={task} />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
          <SectionHeader title={t('workspace.home.activityTitle')} meta={t('workspace.home.activityMeta')} />
          <div className="grid gap-3 px-5 pb-5">
            {activityTasks.map((task) => (
              <div className="rounded-lg border border-slate-200 bg-[#fbfdff] p-4" key={createWorkspaceTaskKey(task)}>
                <p className="text-sm font-black text-[#0d1833]">{resolveTaskTitle(task, t)}</p>
                <p className="mt-1 text-sm font-bold leading-6 text-[#526381]">
                  {resolveTaskAssignee(task, t)} / {t(`tasks.status.${task.status}`)} / {task.dueDate}
                </p>
              </div>
            ))}
            {activityTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]">
                {t('workspace.empty.tasks')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function MyTasksView({
  t,
  taskMoveErrorMessage,
  tasks,
  onMoveTaskStatus,
}: {
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  tasks: ProjectTask[]
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
}) {
  const [draggedTaskKey, setDraggedTaskKey] = useState<string | undefined>()
  const [dropTargetStatus, setDropTargetStatus] = useState<TaskStatus | undefined>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  const canMoveTasks = Boolean(onMoveTaskStatus)

  const moveTaskToStatus = (task: ProjectTask, status: TaskStatus) => {
    if (!onMoveTaskStatus || task.status === status) {
      return
    }

    const taskKey = createWorkspaceTaskKey(task)

    setDraggedTaskKey(undefined)
    setDropTargetStatus(undefined)
    setMovingTaskKeys((currentTaskKeys) => new Set(currentTaskKeys).add(taskKey))
    void onMoveTaskStatus(task, status)
      .catch(() => undefined)
      .finally(() => {
        setMovingTaskKeys((currentTaskKeys) => {
          const nextTaskKeys = new Set(currentTaskKeys)

          nextTaskKeys.delete(taskKey)
          return nextTaskKeys
        })
      })
  }

  const handleDragStart = (event: DragEvent<HTMLElement>, task: ProjectTask) => {
    if (!canMoveTasks) {
      return
    }

    const taskKey = createWorkspaceTaskKey(task)

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-mukuroji-task-key', taskKey)
    event.dataTransfer.setData('text/plain', taskKey)
    setDraggedTaskKey(taskKey)
  }

  const handleDragEnd = () => {
    setDraggedTaskKey(undefined)
    setDropTargetStatus(undefined)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    if (!canMoveTasks || !draggedTaskKey) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetStatus(status)
  }

  const handleDrop = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    event.preventDefault()

    if (!onMoveTaskStatus) {
      return
    }

    const taskKey =
      event.dataTransfer.getData('application/x-mukuroji-task-key') ||
      event.dataTransfer.getData('text/plain') ||
      draggedTaskKey
    const task = taskKey ? findWorkspaceTaskByKey(tasks, taskKey) : undefined

    if (!task) {
      return
    }

    moveTaskToStatus(task, status)
  }

  return (
    <div className="grid gap-4">
      {taskMoveErrorMessage ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-black text-red-700"
          data-testid="my-tasks-move-error"
          role="alert"
        >
          {taskMoveErrorMessage}
        </p>
      ) : null}
      <div
        aria-label={t('workspace.myTasks.title')}
        className="grid grid-cols-4 gap-4 max-[1240px]:overflow-x-auto max-[1240px]:pb-2 max-[900px]:grid-cols-1 max-[900px]:overflow-visible"
        data-testid="my-tasks-kanban"
      >
        {myTaskKanbanStatuses.map((status) => {
          const columnTasks = tasks.filter((task) => task.status === status)
          const isDropTarget = dropTargetStatus === status

          return (
            <section
              aria-label={t(`tasks.status.${status}`)}
              className={`min-h-[420px] min-w-[260px] rounded-lg border bg-slate-50 shadow-[0_18px_42px_rgba(30,52,88,0.05)] transition ${
                isDropTarget ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200'
              }`}
              data-testid={`my-tasks-column-${status}`}
              key={status}
              onDragLeave={() => setDropTargetStatus(undefined)}
              onDragOver={(event) => handleDragOver(event, status)}
              onDrop={(event) => handleDrop(event, status)}
            >
              <SectionHeader
                title={t(`tasks.status.${status}`)}
                meta={t('tasks.board.columnCount').replace('{count}', String(columnTasks.length))}
              />
              <div className="grid gap-3 px-4 pb-4">
                {columnTasks.map((task) => {
                  const taskKey = createWorkspaceTaskKey(task)
                  const isMoving = movingTaskKeys.has(taskKey)

                  return (
                    <CompactTaskCard
                      draggable={canMoveTasks && !isMoving}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      key={taskKey}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onStatusChange={(nextStatus) => moveTaskToStatus(task, nextStatus)}
                    />
                  )
                })}
                {columnTasks.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm font-bold text-[#526381]">
                    {t('tasks.board.empty')}
                  </p>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function InboxView({
  t,
  tasks,
}: {
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const inboxTasks = createInboxTasks(tasks)
  const responseMinutes = Math.max(0, inboxTasks.length * 6)

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1080px]:grid-cols-1">
      <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader
          title={t('workspace.inbox.queueTitle')}
          meta={t('workspace.inbox.queueMeta').replace('{count}', String(inboxTasks.length))}
        />
        <div className="divide-y divide-slate-100">
          {inboxTasks.map((task) => (
            <div className="grid gap-3 p-5" key={createWorkspaceTaskKey(task)}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-base font-black text-[#0d1833]">{resolveTaskTitle(task, t)}</p>
                  <p className="mt-1 text-sm font-bold leading-6 text-[#526381]">
                    {resolveTaskAssignee(task, t)} / {task.dueDate}
                  </p>
                </div>
                <span className={`rounded-lg border px-3 py-1.5 text-xs font-black ${resolveInboxToneClassName(task)}`}>
                  {t(`tasks.priority.${task.priority}`)}
                </span>
              </div>
            </div>
          ))}
          {inboxTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-bold text-[#526381]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>

      <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <p className="text-sm font-black uppercase tracking-normal text-blue-600">
          {t('workspace.inbox.sla')}
        </p>
        <p className="mt-4 text-5xl font-black leading-none text-[#0d1833]">{responseMinutes}m</p>
        <p className="mt-3 text-sm font-bold leading-6 text-[#526381]">
          {t('workspace.inbox.slaDescription')}
        </p>
      </aside>
    </div>
  )
}

function DashboardWorkspaceView({
  summary,
  t,
  tasks,
  teams,
}: {
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const projects = teams.flatMap((team) =>
    team.projects.map((project) => ({
      progress: calculateProjectProgress(filterTasksByProjectIds(tasks, [project.id])),
      id: `${team.id}-${project.id}`,
      name: project.name,
      teamName: team.name,
      riskKey: resolvePortfolioRiskKey(filterTasksByProjectIds(tasks, [project.id])),
    })),
  )

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="blue" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.deliveryRate')} value={`${calculateProjectProgress(tasks)}%`} tone="amber" />
      </div>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader title={t('workspace.dashboard.portfolioTitle')} meta={t('workspace.dashboard.portfolioMeta')} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-left">
            <thead>
              <tr className="border-y border-slate-200 bg-[#fbfdff] text-sm font-black text-[#263550]">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.slice(0, 6).map((project) => (
                <tr className="border-b border-slate-100 text-sm font-bold text-[#0d1833]" key={project.id}>
                  <td className="px-5 py-4">{project.name}</td>
                  <td className="px-5 py-4 text-[#526381]">{project.teamName}</td>
                  <td className="px-5 py-4">
                    <ProgressBar value={project.progress} />
                  </td>
                  <td className="px-5 py-4">{t(project.riskKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function ReportsView({
  summary,
  t,
  tasks,
}: {
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const availableThroughput = Math.max(0, summary.tasks - summary.blocked)
  const blockedRate = summary.tasks > 0
    ? Math.round((summary.blocked / summary.tasks) * 100)
    : 0
  const reportTrendItems = createReportTrendItems(tasks)

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1080px]:grid-cols-1">
      <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader title={t('workspace.reports.trendTitle')} meta={t('workspace.reports.trendMeta')} />
        <div className="flex h-[320px] items-end gap-4 px-5 pb-6 pt-4">
          {reportTrendItems.map((item) => (
            <div className="grid flex-1 gap-3" key={item.id}>
              <div className="flex h-[240px] items-end rounded-lg bg-slate-100 p-2">
                <div
                  className="w-full rounded-md bg-blue-600"
                  style={{ height: `${item.value}%` }}
                />
              </div>
              <p className="text-center text-sm font-black text-[#526381]">{item.label}</p>
            </div>
          ))}
        </div>
      </section>

      <aside className="grid gap-4">
        <MetricCard label={t('workspace.reports.throughput')} value={availableThroughput} tone="emerald" />
        <MetricCard label={t('workspace.reports.blockedRate')} value={`${blockedRate}%`} tone="red" />
        <MetricCard label={t('workspace.reports.cycleTime')} value={calculateAverageCycleLabel(tasks)} tone="amber" />
      </aside>
    </div>
  )
}

function PermissionsView({
  errorMessage,
  isLoading,
  isUsersLoading,
  isSystemAdmin,
  members,
  projects,
  selectedProjectId,
  t,
  users,
  usersErrorMessage,
  usersNextToken,
  userQuery,
  onLoadMoreUsers,
  onRemoveMember,
  onSelectProject,
  onUserQueryChange,
  onUpdateMember,
}: PermissionsViewProps) {
  const [formState, setFormState] = useState<ProjectMemberFormState>({
    userId: '',
    role: 'member',
  })
  const [savingMemberKey, setSavingMemberKey] = useState<string | undefined>()
  const [isLoadingMoreUsers, setIsLoadingMoreUsers] = useState(false)
  const [localErrorMessage, setLocalErrorMessage] = useState<string | undefined>()
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0]
  const selectedUserId = formState.userId && users.some((user) => user.id === formState.userId)
    ? formState.userId
    : users[0]?.id ?? ''

  const saveMember = async (memberKey: string, input: UpdateProjectMemberInput) => {
    if (!selectedProject || !onUpdateMember) {
      return
    }

    setSavingMemberKey(memberKey)
    setLocalErrorMessage(undefined)

    try {
      await onUpdateMember(selectedProject.id, memberKey, input)
    } catch {
      setLocalErrorMessage(t('workspace.permissions.error'))
    } finally {
      setSavingMemberKey(undefined)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedUserId) {
      setLocalErrorMessage(t('workspace.permissions.error'))
      return
    }

    await saveMember(selectedUserId, {
      role: formState.role,
    })
    setFormState({ userId: '', role: 'member' })
  }

  const handleLoadMoreUsers = async () => {
    if (!onLoadMoreUsers) {
      return
    }

    setIsLoadingMoreUsers(true)
    setLocalErrorMessage(undefined)

    try {
      await onLoadMoreUsers()
    } catch {
      setLocalErrorMessage(t('workspace.permissions.usersError'))
    } finally {
      setIsLoadingMoreUsers(false)
    }
  }

  const handleRemoveMember = async (member: ProjectMember) => {
    if (!selectedProject || !onRemoveMember) {
      return
    }

    setSavingMemberKey(member.id)
    setLocalErrorMessage(undefined)

    try {
      await onRemoveMember(selectedProject.id, member.id)
    } catch {
      setLocalErrorMessage(t('workspace.permissions.error'))
    } finally {
      setSavingMemberKey(undefined)
    }
  }

  return (
    <div className="grid gap-6" data-testid="permissions-view">
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-[1080px]:grid-cols-1">
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
          <div className="grid gap-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <label className="grid min-w-[260px] flex-1 gap-2 text-sm font-black text-[#263550]" htmlFor="permissions-project">
                {t('workspace.permissions.projectLabel')}
                <select
                  className="h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                  data-testid="permissions-project-select"
                  id="permissions-project"
                  value={selectedProject?.id ?? ''}
                  onChange={(event) => onSelectProject?.(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={`${project.teamName}-${project.id}`} value={project.id}>
                      {project.name} / {project.teamName}
                    </option>
                  ))}
                </select>
              </label>
              {isSystemAdmin ? (
                <span className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-black text-blue-700">
                  {t('workspace.permissions.systemAdmin')}
                </span>
              ) : null}
            </div>

            {selectedProject ? (
              <form className="grid grid-cols-2 gap-3 max-[780px]:grid-cols-1" onSubmit={handleSubmit}>
                <label className="grid gap-2 text-sm font-black text-[#263550]" htmlFor="permissions-user-search">
                  {t('workspace.permissions.userSearch')}
                  <input
                    className="h-12 rounded-lg border border-slate-300 px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                    data-testid="permissions-user-search"
                    id="permissions-user-search"
                    placeholder={t('workspace.permissions.userSearchPlaceholder')}
                    type="search"
                    value={userQuery}
                    onChange={(event) => onUserQueryChange?.(event.target.value)}
                  />
                </label>
                <label className="grid gap-2 text-sm font-black text-[#263550]" htmlFor="permissions-user-select">
                  {t('workspace.permissions.memberEmail')}
                  <select
                    className="h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                    data-testid="permissions-user-select"
                    disabled={users.length === 0}
                    id="permissions-user-select"
                    value={selectedUserId}
                    onChange={(event) => setFormState((current) => ({ ...current, userId: event.target.value }))}
                  >
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {formatProjectUserOption(user)}
                      </option>
                    ))}
                  </select>
                </label>
                <RoleSelect
                  id="permissions-member-role"
                  label={t('workspace.permissions.roleLabel')}
                  t={t}
                  value={formState.role}
                  onChange={(role) => setFormState((current) => ({ ...current, role }))}
                />
                <button
                  className="self-end min-h-12 rounded-lg bg-blue-600 px-5 text-sm font-black text-white shadow-[0_14px_30px_rgba(37,99,235,0.22)] transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-400"
                  data-testid="permissions-submit"
                  disabled={!selectedUserId || savingMemberKey === selectedUserId}
                  type="submit"
                >
                  {savingMemberKey === selectedUserId
                    ? t('workspace.permissions.saving')
                    : t('workspace.permissions.save')}
                </button>
                <div className="col-span-full flex flex-wrap items-center gap-3 text-sm font-bold text-[#526381]">
                  {isUsersLoading ? <span>{t('workspace.permissions.usersLoading')}</span> : null}
                  {usersErrorMessage ? <span className="text-red-600">{usersErrorMessage}</span> : null}
                  {!isUsersLoading && users.length === 0 ? <span>{t('workspace.permissions.usersEmpty')}</span> : null}
                  {usersNextToken ? (
                    <button
                      className="min-h-9 rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-[#263550] transition hover:border-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:text-slate-400"
                      data-testid="permissions-load-more-users"
                      disabled={isLoadingMoreUsers}
                      type="button"
                      onClick={handleLoadMoreUsers}
                    >
                      {isLoadingMoreUsers
                        ? t('workspace.permissions.saving')
                        : t('workspace.permissions.loadMoreUsers')}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-sm font-bold text-[#526381]">
                {t('workspace.permissions.projectMissing')}
              </p>
            )}
            {errorMessage || localErrorMessage ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">
                {localErrorMessage ?? errorMessage}
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
          <p className="text-sm font-black uppercase tracking-normal text-blue-600">
            {t('workspace.permissions.policyTitle')}
          </p>
          <div className="mt-4 grid gap-3">
            {projectMemberRoleOptions.map((role) => (
              <div className="rounded-lg border border-slate-200 p-3" key={role}>
                <p className="text-sm font-black text-[#0d1833]">
                  {t(`workspace.permissions.role.${role}`)}
                </p>
                <p className="mt-1 text-sm font-bold leading-6 text-[#526381]">
                  {t(`workspace.permissions.${role}Policy`)}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader
          title={t('workspace.permissions.directoryTitle')}
          meta={selectedProject?.name ?? t('workspace.permissions.projectMissing')}
        />
        {isLoading ? (
          <p className="px-5 py-8 text-sm font-bold text-[#526381]">
            {t('workspace.permissions.loading')}
          </p>
        ) : (
          <div className="grid divide-y divide-slate-100">
            {members.map((member) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_180px_110px] items-center gap-4 p-5 max-[820px]:grid-cols-1"
                data-testid={`permission-member-row-${createProjectMemberTestId(member.id)}`}
                key={member.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-base font-black text-[#0d1833]">{member.name ?? member.email}</p>
                  <p className="mt-1 truncate text-sm font-bold text-[#526381]">
                    {member.email}
                    {member.status ? ` / ${member.status}` : ''}
                  </p>
                </div>
                <RoleSelect
                  id={`permissions-role-${member.id}`}
                  label={t('workspace.permissions.roleLabel')}
                  t={t}
                  testId={`permission-role-select-${createProjectMemberTestId(member.id)}`}
                  value={member.role}
                  onChange={(role) =>
                    saveMember(member.id, {
                      role,
                    })
                  }
                />
                <button
                  className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-black text-[#0d1833] transition hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-400"
                  data-testid={`permission-remove-${createProjectMemberTestId(member.id)}`}
                  disabled={savingMemberKey === member.id}
                  type="button"
                  onClick={() => handleRemoveMember(member)}
                >
                  {savingMemberKey === member.id
                    ? t('workspace.permissions.saving')
                    : t('workspace.permissions.remove')}
                </button>
              </div>
            ))}
            {members.length === 0 ? (
              <p className="px-5 py-8 text-sm font-bold text-[#526381]">
                {t('workspace.permissions.empty')}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function RoleSelect({
  id,
  label,
  t,
  testId,
  value,
  onChange,
}: RoleSelectProps) {
  return (
    <label className="grid gap-2 text-sm font-black text-[#263550]" htmlFor={id}>
      {label}
      <select
        className="h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
        data-testid={testId}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as ProjectMemberRole)}
      >
        {projectMemberRoleOptions.map((role) => (
          <option key={role} value={role}>
            {t(`workspace.permissions.role.${role}`)}
          </option>
        ))}
      </select>
    </label>
  )
}

function HelpView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <InfoGrid
      items={[
        ['workspace.help.guideTitle', 'workspace.help.guideDescription'],
        ['workspace.help.runbookTitle', 'workspace.help.runbookDescription'],
        ['workspace.help.supportTitle', 'workspace.help.supportDescription'],
        ['workspace.help.statusTitle', 'workspace.help.statusDescription'],
      ]}
      t={t}
    />
  )
}

function SettingsView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <InfoGrid
      items={[
        ['workspace.settings.profileTitle', 'workspace.settings.profileDescription'],
        ['workspace.settings.notificationTitle', 'workspace.settings.notificationDescription'],
        ['workspace.settings.permissionTitle', 'workspace.settings.permissionDescription'],
        ['workspace.settings.integrationTitle', 'workspace.settings.integrationDescription'],
      ]}
      t={t}
    />
  )
}

function TeamOverviewView({
  team,
  t,
  tasks,
}: {
  team?: ProjectDirectoryTeam
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const projects = team?.projects ?? []
  const projectIds = projects.map((project) => project.id)
  const teamTasks = filterTasksByProjectIds(tasks, projectIds)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        <MetricCard
          label={t('workspace.metric.projects')}
          testId="team-overview-projects"
          value={projects.length}
          tone="blue"
        />
        <MetricCard
          label={t('workspace.metric.openTasks')}
          testId="team-overview-open-tasks"
          value={teamTasks.filter((task) => task.status !== 'done').length}
          tone="emerald"
        />
        <MetricCard
          label={t('workspace.metric.blocked')}
          testId="team-overview-blocked"
          value={teamTasks.filter((task) => task.priority === 'high').length}
          tone="red"
        />
      </div>
      <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader title={t('workspace.teamOverview.projectsTitle')} meta={team?.name ?? t('workspace.team.missing')} />
        <div className="grid gap-3 p-5">
          {projects.map((project) => (
            <div className="grid gap-3 rounded-lg border border-slate-200 p-4" key={project.id}>
              <div className="flex items-center justify-between gap-4">
                <p className="font-black text-[#0d1833]">{project.name}</p>
                <span className="text-sm font-black text-blue-600">
                  {calculateProjectProgress(filterTasksByProjectIds(tasks, [project.id]))}%
                </span>
              </div>
              <ProgressBar value={calculateProjectProgress(filterTasksByProjectIds(tasks, [project.id]))} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function TeamMembersView({
  team,
  t,
  tasks,
}: {
  team?: ProjectDirectoryTeam
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const projects = team?.projects ?? []
  const members = createTeamMemberRows(filterTasksByProjectIds(tasks, projects.map((project) => project.id)), t)

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
      <SectionHeader title={t('workspace.members.directoryTitle')} meta={team?.name ?? t('workspace.team.missing')} />
      <div className="grid divide-y divide-slate-100">
        {members.map((member) => (
          <div className="grid grid-cols-[1fr_160px_220px] items-center gap-5 p-5 max-[820px]:grid-cols-1" key={member.id}>
            <div className="min-w-0">
              <p className="text-base font-black text-[#0d1833]">{member.name}</p>
              <p className="mt-1 text-sm font-bold text-[#526381]">
                {t('workspace.members.taskCount').replace('{count}', String(member.taskCount))}
              </p>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-normal text-[#69758a]">
                {t('workspace.members.load')}
              </p>
              <p className="mt-1 text-2xl font-black text-[#0d1833]">{member.load}%</p>
            </div>
            <p className="text-sm font-bold leading-6 text-[#526381]">
              {t('workspace.members.openTaskCount').replace('{count}', String(member.openTaskCount))}
            </p>
          </div>
        ))}
        {members.length === 0 ? (
          <p className="px-5 py-8 text-sm font-bold text-[#526381]">
            {t('workspace.empty.tasks')}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function MetricCard({
  label,
  testId,
  tone,
  value,
}: {
  label: string
  testId?: string
  tone: 'amber' | 'blue' | 'emerald' | 'red'
  value: number | string
}) {
  const toneClassNames = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  } as const

  return (
    <section
      className={`rounded-lg border bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)] ${toneClassNames[tone]}`}
      data-testid={testId}
    >
      <p className="text-sm font-black text-[#263550]">{label}</p>
      <p className="mt-3 text-4xl font-black leading-none text-current">{value}</p>
    </section>
  )
}

function SectionHeader({ meta, title }: { meta?: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
      <h2 className="text-lg font-black text-[#0d1833]">{title}</h2>
      {meta ? <p className="text-sm font-bold text-[#526381]">{meta}</p> : null}
    </div>
  )
}

function TaskListRow({ t, task }: { t: (key: MessageKey) => string; task: ProjectTask }) {
  return (
    <div className="grid grid-cols-[1fr_140px_110px] items-center gap-4 p-5 text-sm font-bold max-[760px]:grid-cols-1">
      <div className="min-w-0">
        <p className="truncate text-base font-black text-[#0d1833]">{resolveTaskTitle(task, t)}</p>
        <p className="mt-1 text-[#526381]">{resolveTaskAssignee(task, t)}</p>
      </div>
      <StatusPill status={task.status} t={t} />
      <span className="text-[#526381]">{task.dueDate}</span>
    </div>
  )
}

function CompactTaskCard({
  draggable = false,
  isDragging = false,
  isMoving = false,
  onDragEnd,
  onDragStart,
  onStatusChange,
  t,
  task,
  testId,
}: {
  draggable?: boolean
  isDragging?: boolean
  isMoving?: boolean
  onDragEnd?: () => void
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onStatusChange?: (status: TaskStatus) => void
  t: (key: MessageKey) => string
  task: ProjectTask
  testId?: string
}) {
  const statusSelectLabel = t('workspace.myTasks.moveStatusLabel').replace(
    '{title}',
    resolveTaskTitle(task, t),
  )

  return (
    <article
      aria-grabbed={isDragging || undefined}
      className={`rounded-lg border border-slate-200 bg-white p-4 transition ${
        draggable ? 'cursor-grab hover:border-blue-300 hover:shadow-[0_14px_30px_rgba(30,52,88,0.08)] active:cursor-grabbing' : ''
      } ${isDragging ? 'opacity-50 ring-2 ring-blue-300' : ''} ${isMoving ? 'opacity-70' : ''}`}
      data-testid={testId}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <p className="text-sm font-black leading-6 text-[#0d1833]">{resolveTaskTitle(task, t)}</p>
      <p className="mt-2 text-xs font-black uppercase tracking-normal text-[#526381]">{task.dueDate}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} t={t} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
      {onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="mt-3 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-[#263550] outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          data-testid={testId ? `${testId}-status-select` : undefined}
          disabled={isMoving}
          value={task.status}
          onChange={(event) => {
            const nextStatus = readMyTaskKanbanStatus(event.target.value)

            if (nextStatus) {
              onStatusChange(nextStatus)
            }
          }}
        >
          {myTaskKanbanStatuses.map((status) => (
            <option key={status} value={status}>
              {t(`tasks.status.${status}`)}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  )
}

function StatusPill({ status, t }: { status: TaskStatus; t: (key: MessageKey) => string }) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'bg-blue-100 text-blue-700',
    review: 'bg-amber-100 text-amber-700',
    todo: 'bg-slate-100 text-[#263550]',
    done: 'bg-emerald-100 text-emerald-700',
  }

  return (
    <span className={`inline-flex w-fit rounded-lg px-3 py-1.5 text-xs font-black ${statusClasses[status]}`}>
      {t(`tasks.status.${status}`)}
    </span>
  )
}

function PriorityPill({ priority, t }: { priority: TaskPriority; t: (key: MessageKey) => string }) {
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-amber-100 text-amber-700',
    low: 'bg-emerald-100 text-emerald-700',
  }

  return (
    <span className={`inline-flex w-fit rounded-lg px-3 py-1.5 text-xs font-black ${priorityClasses[priority]}`}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

function InfoGrid({
  items,
  t,
}: {
  items: Array<[MessageKey, MessageKey]>
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
      {items.map(([titleKey, descriptionKey]) => (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]" key={titleKey}>
          <h2 className="text-lg font-black text-[#0d1833]">{t(titleKey)}</h2>
          <p className="mt-3 text-sm font-bold leading-6 text-[#526381]">{t(descriptionKey)}</p>
        </section>
      ))}
    </div>
  )
}

function findActiveTeam(teams: ProjectDirectoryTeam[], activeTeamId?: string) {
  if (activeTeamId) {
    return teams.find((team) => team.id === activeTeamId)
  }

  return teams[0]
}

async function loadProjectTasks(
  projectIds: readonly string[],
  accessToken: string,
): Promise<ProjectTask[]> {
  const taskGroups = await Promise.all(
    projectIds.map((projectId) => getProjectTasks(projectId, accessToken)),
  )

  return taskGroups.flat()
}

function uniqueProjectIds(teams: ProjectDirectoryTeam[]) {
  return Array.from(
    new Set(teams.flatMap((team) => team.projects.map((project) => project.id))),
  )
}

function createPermissionProjectOptions(teams: ProjectDirectoryTeam[]) {
  const options: PermissionProjectOption[] = []
  const projectIds = new Set<string>()

  for (const team of teams) {
    for (const project of team.projects) {
      if (projectIds.has(project.id)) {
        continue
      }

      projectIds.add(project.id)
      options.push({
        id: project.id,
        name: project.name,
        teamName: team.name,
      })
    }
  }

  return options
}

function createProjectMemberTestId(memberKey: string) {
  return memberKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function formatProjectUserOption(user: ProjectUser) {
  return `${user.name ?? user.email} / ${user.email}`
}

function createProjectUsersPageKey(projectId: string | undefined, query: string) {
  return `${projectId ?? ''}\u0000${query.trim()}`
}

function mergeProjectUsers(currentUsers: ProjectUser[], nextUsers: ProjectUser[]) {
  const usersById = new Map(currentUsers.map((user) => [user.id, user]))

  for (const user of nextUsers) {
    usersById.set(user.id, user)
  }

  return Array.from(usersById.values())
}

function createWorkspaceTaskKey(task: ProjectTask) {
  return task.projectId ? `${task.projectId}:${task.id}` : task.id
}

function createWorkspaceTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskKey(task).replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function readMyTaskKanbanStatus(value: string) {
  return myTaskKanbanStatuses.find((status) => status === value)
}

function findWorkspaceTaskByKey(tasks: ProjectTask[], taskKey: string) {
  return tasks.find((task) => createWorkspaceTaskKey(task) === taskKey)
}

function updateWorkspaceTaskStatus<TTask extends ProjectTask>(
  tasks: TTask[],
  targetTask: ProjectTask,
  status: TaskStatus,
  expectedCurrentStatus?: TaskStatus,
) {
  const targetTaskKey = createWorkspaceTaskKey(targetTask)

  return tasks.map((task): TTask =>
    createWorkspaceTaskKey(task) === targetTaskKey &&
    (expectedCurrentStatus === undefined || task.status === expectedCurrentStatus)
      ? {
          ...task,
          status,
        }
      : task,
  )
}

function replaceWorkspaceTask<TTask extends ProjectTask>(
  tasks: TTask[],
  updatedTask: ProjectTask,
) {
  const updatedTaskKey = createWorkspaceTaskKey(updatedTask)

  return tasks.map((task): TTask =>
    createWorkspaceTaskKey(task) === updatedTaskKey
      ? {
          ...task,
          ...updatedTask,
        }
      : task,
  )
}

function filterTasksByProjectIds(tasks: ProjectTask[], projectIds: readonly string[]) {
  const projectIdSet = new Set(projectIds)

  if (projectIdSet.size === 0) {
    return []
  }

  return tasks.filter((task) => !task.projectId || projectIdSet.has(task.projectId))
}

function createDashboardSummary(
  teams: ProjectDirectoryTeam[],
  tasks: ProjectTask[],
): DashboardSummary {
  return {
    projects: uniqueProjectIds(teams).length,
    tasks: tasks.filter((task) => task.status !== 'done').length,
    blocked: tasks.filter((task) => task.priority === 'high' && task.status !== 'done').length,
    updatedAt: new Date().toISOString(),
    source: 'dynamodb',
  }
}

function resolveTaskTitle(task: ProjectTask, t: (key: MessageKey) => string) {
  return task.title ?? (task.titleKey ? t(task.titleKey) : task.id)
}

function resolveTaskAssignee(task: ProjectTask, t: (key: MessageKey) => string) {
  return task.assigneeName ??
    task.assigneeEmail ??
    task.assigneeUserId ??
    task.assignee ??
    (task.assigneeKey ? t(task.assigneeKey) : '')
}

function createActivityTasks(tasks: ProjectTask[]) {
  return [...tasks]
    .sort((firstTask, secondTask) => secondTask.dueDate.localeCompare(firstTask.dueDate))
    .slice(0, 3)
}

function createInboxTasks(tasks: ProjectTask[]) {
  return tasks
    .filter((task) => task.status !== 'done' && (task.priority === 'high' || task.status === 'review'))
    .slice(0, 8)
}

function resolveInboxToneClassName(task: ProjectTask) {
  if (task.priority === 'high') {
    return 'border-red-200 bg-red-50 text-red-700'
  }

  if (task.status === 'review') {
    return 'border-amber-200 bg-amber-50 text-amber-700'
  }

  return 'border-blue-200 bg-blue-50 text-blue-700'
}

function calculateProjectProgress(tasks: ProjectTask[]) {
  if (tasks.length === 0) {
    return 0
  }

  return Math.round((tasks.filter((task) => task.status === 'done').length / tasks.length) * 100)
}

function resolvePortfolioRiskKey(tasks: ProjectTask[]): MessageKey {
  if (tasks.some((task) => task.priority === 'high' && task.status !== 'done')) {
    return 'workspace.risk.watch'
  }

  if (tasks.length === 0 || tasks.every((task) => task.status === 'done')) {
    return 'workspace.risk.low'
  }

  return 'workspace.risk.clear'
}

function createReportTrendItems(tasks: ProjectTask[]) {
  const doneTasks = tasks.filter((task) => task.status === 'done')
  const groupedByDueDate = new Map<string, number>()

  for (const task of doneTasks) {
    groupedByDueDate.set(task.dueDate, (groupedByDueDate.get(task.dueDate) ?? 0) + 1)
  }

  const maxCount = Math.max(1, ...groupedByDueDate.values())
  const labels = Array.from(groupedByDueDate.entries())
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .slice(-5)
    .map(([date, count]) => ({
      id: date,
      label: date,
      value: Math.max(12, Math.round((count / maxCount) * 100)),
    }))

  return labels.length > 0
    ? labels
    : [{ id: 'empty', label: '-', value: 12 }]
}

function calculateAverageCycleLabel(tasks: ProjectTask[]) {
  const doneCount = tasks.filter((task) => task.status === 'done').length

  if (doneCount === 0) {
    return '0d'
  }

  return `${Math.max(1, Math.round(tasks.length / doneCount))}d`
}

function createTeamMemberRows(tasks: ProjectTask[], t: (key: MessageKey) => string) {
  const tasksByAssignee = new Map<string, ProjectTask[]>()

  for (const task of tasks) {
    const assignee = resolveTaskAssignee(task, t) || t('workspace.members.unassigned')
    tasksByAssignee.set(assignee, [...(tasksByAssignee.get(assignee) ?? []), task])
  }

  return Array.from(tasksByAssignee.entries()).map(([name, assigneeTasks]) => {
    const openTaskCount = assigneeTasks.filter((task) => task.status !== 'done').length

    return {
      id: name,
      name,
      load: Math.round((openTaskCount / Math.max(1, assigneeTasks.length)) * 100),
      openTaskCount,
      taskCount: assigneeTasks.length,
    }
  })
}

function formatTeamText(value: string, teamName?: string) {
  return value.replace('{team}', teamName ?? '')
}
