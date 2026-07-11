import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
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
  getProjectIssues,
  updateTeamIssue,
  type TeamIssue,
} from '../issues/api'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  getProjectDirectory,
  getProjectMembers,
  type ProjectDirectoryProject,
  type ProjectDirectoryTeam,
  type ProjectMember,
  type ProjectMemberRole,
} from '../projects/api'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  fontSizePreferenceOptions,
  getInitialFontSizePreference,
  setFontSizePreference as saveFontSizePreference,
  type FontSizePreference,
} from '../preferences/fontSize'
import {
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
 * チーム配下プロジェクトから取得した project member の所属情報です。
 */
type TeamProjectMemberAccess = {
  /**
   * メンバーが所属しているプロジェクト ID です。
   */
  projectId: string
  /**
   * メンバーが所属しているプロジェクト名です。
   */
  projectName: string
  /**
   * プロジェクト API から取得した member 行です。
   */
  member: ProjectMember
}

/**
 * チーム配下プロジェクトの member 取得結果です。
 */
type TeamProjectMembersResult = {
  /**
   * 取得に成功したプロジェクトの member 所属情報です。
   */
  members: TeamProjectMemberAccess[]
  /**
   * member 取得に失敗したプロジェクト ID の一覧です。
   */
  failedProjectIds: string[]
}

/**
 * チーム概要テーブルで比較するプロジェクト集計行です。
 */
type TeamProjectSummary = {
  /**
   * プロジェクト ID です。
   */
  id: string
  /**
   * プロジェクト名です。
   */
  name: string
  /**
   * 完了済みタスク比率を百分率にした進捗です。
   */
  progress: number
  /**
   * 未完了タスク件数です。
   */
  openTaskCount: number
  /**
   * review 状態のタスク件数です。
   */
  reviewTaskCount: number
  /**
   * 高優先度または期限超過のタスク件数です。
   */
  attentionTaskCount: number
  /**
   * プロジェクト member 件数です。
   */
  memberCount: number
  /**
   * manager ロールの member 件数です。
   */
  managerCount: number
  /**
   * 次に開くべきタスクです。
   */
  nextTask?: ProjectTask
}

/**
 * チームメンバー画面の role filter です。
 */
type TeamMemberRoleFilter = ProjectMemberRole | 'all'

/**
 * チームメンバーが参加しているプロジェクトとロールです。
 */
type TeamMemberProjectAccess = {
  /**
   * 参加プロジェクト ID です。
   */
  projectId: string
  /**
   * 参加プロジェクト名です。
   */
  projectName: string
  /**
   * プロジェクト内の member role です。
   */
  role: ProjectMemberRole
}

/**
 * チームメンバーディレクトリに表示する集約行です。
 */
type TeamMemberRow = {
  /**
   * 行を識別する member key です。
   */
  id: string
  /**
   * 画面に表示する member 名です。
   */
  name: string
  /**
   * member のメールアドレスです。
   */
  email: string
  /**
   * 複数プロジェクトのうち最も強い member role です。
   */
  role?: ProjectMemberRole
  /**
   * 参加しているプロジェクトごとの role 一覧です。
   */
  projectAccess: TeamMemberProjectAccess[]
  /**
   * 担当タスク件数です。
   */
  taskCount: number
  /**
   * 未完了タスク件数です。
   */
  openTaskCount: number
  /**
   * review 状態の担当タスク件数です。
   */
  reviewTaskCount: number
  /**
   * 高優先度または期限超過の担当タスク件数です。
   */
  attentionTaskCount: number
  /**
   * 未完了タスク比率から計算した負荷表示用の百分率です。
   */
  loadPercent: number
  /**
   * 担当タスクのうち最も近い期限日です。
   */
  nextDueDate?: string
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
   * 自分の担当タスク判定に使う Cognito の安定識別子です。
   */
  userIdentityAliases?: string[]
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
   * 選択中チーム配下プロジェクトの member 所属情報です。
   */
  teamProjectMembers?: TeamProjectMemberAccess[]
  /**
   * 選択中チーム配下プロジェクトの member 取得に失敗した projectId です。
   */
  teamProjectMembersFailedProjectIds?: string[]
  /**
   * チーム横断 member 権限を読み込み中かどうかです。
   */
  isTeamProjectMembersLoading?: boolean
  /**
   * 現在選択されているフォントサイズ設定です。
   */
  fontSizePreference: FontSizePreference
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
   * マイタスクの状態列を移動したときの callback です。
   */
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
  /**
   * ワークスペースのキュー行から作業詳細へ遷移するときの callback です。
   */
  onOpenTask?: (task: ProjectTask) => void
  /**
   * フォントサイズ設定が変更されたときの callback です。
   */
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
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

const emptyProjectDirectory: ProjectDirectoryTeam[] = []
const emptyProjectTasks: ProjectTask[] = []
const emptyTeamProjectMembers: TeamProjectMemberAccess[] = []
const emptyTeamProjectMemberFailures: string[] = []
const emptyUserIdentityAliases: string[] = []
const myTaskKanbanStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]
const inboxFilterOptions = ['all', 'mine', 'overdue', 'review', 'high'] as const
const reportStatusOrder = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]
const reportPriorityOrder = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]

/**
 * 受信箱の要確認タスクを絞り込む条件です。
 */
type InboxFilter = (typeof inboxFilterOptions)[number]

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
  const [fontSizePreference, setFontSizePreferenceState] = useState<FontSizePreference>(() =>
    getInitialFontSizePreference(),
  )
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
  const activeTeam = useMemo(() => findActiveTeam(teams, params.teamId), [params.teamId, teams])
  const activeTeamProjects = activeTeam?.projects ?? []
  const isTeamManagementView = view === 'team-overview' || view === 'team-members'
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
      loadTeamProjectMembers(currentAccessToken, activeTeamProjects),
    apiSWRConfig,
  )
  const [taskMoveErrorMessage, setTaskMoveErrorMessage] = useState<string | undefined>()
  const pendingTaskMoveKeysRef = useRef(new Set<string>())
  const summary = useMemo(() => createDashboardSummary(teams, tasks), [tasks, teams])
  const metadata = workspaceViewMetadata[view]
  const title = t(metadata.titleKey)
  const userLabel =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userIdentityAliases = useMemo(
    () => [user?.username, user?.attributes.email, user?.attributes.sub]
      .filter((value): value is string => Boolean(value)),
    [user],
  )
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

  const handleFontSizePreferenceChange = (preference: FontSizePreference) => {
    setFontSizePreferenceState(preference)
    saveFontSizePreference(preference)
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

  const handleMoveTaskStatus = async (task: ProjectTask, status: TaskStatus) => {
    if (!accessToken || !task.projectId || task.status === status || isLegacyWorkspaceTask(task)) {
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
      const updatedTask = await updateWorkspaceTaskRemote(task, accessToken, status)
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
      fontSizePreference={fontSizePreference}
      isLoading={isLoading}
      isTeamProjectMembersLoading={Boolean(teamProjectMembersKey && isTeamProjectMembersLoading)}
      locale={locale}
      onFontSizePreferenceChange={handleFontSizePreferenceChange}
      onLogout={handleLogout}
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectProject={(projectId, teamId) =>
        navigate(createProjectIssuesPath(projectId, teamId))
      }
      onSelectTeamView={(teamId, viewId) =>
        navigate(createTeamViewPath(teamId, viewId))
      }
      onCreateProject={handleCreateProject}
      onCreateTeam={handleCreateTeam}
      onArchiveProject={handleArchiveProject}
      onArchiveTeam={handleArchiveTeam}
      onMoveTaskStatus={handleMoveTaskStatus}
      onOpenTask={(task) => {
        if (!task.projectId || !task.teamId) {
          return
        }

        navigate(createProjectIssuesPath(task.projectId, task.teamId, task.id))
      }}
      summary={summary}
      taskMoveErrorMessage={taskMoveErrorMessage}
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

/**
 * 認証済みワークスペース UI を描画する Storybook 兼用 screen です。
 */
export function WorkspaceScreen({
  locale,
  view,
  userLabel,
  userIdentityAliases = emptyUserIdentityAliases,
  userInitial,
  summary,
  teams,
  activeTeamId,
  tasks,
  teamProjectMembers = emptyTeamProjectMembers,
  teamProjectMembersFailedProjectIds = emptyTeamProjectMemberFailures,
  isTeamProjectMembersLoading = false,
  fontSizePreference,
  isLoading = false,
  onLogout,
  onSelectNav,
  onSelectTeamView,
  onSelectProject,
  onCreateProject,
  onCreateTeam,
  onArchiveProject,
  onArchiveTeam,
  onMoveTaskStatus,
  onOpenTask,
  onFontSizePreferenceChange,
  taskMoveErrorMessage,
}: WorkspaceScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const metadata = workspaceViewMetadata[view]
  const activeTeam = findActiveTeam(teams, activeTeamId)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
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

      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={() => setIsMobileSidebarOpen(true)}
              />
              <div className="min-w-0">
                <p className="workbench-eyebrow">
                  {t(metadata.eyebrowKey)}
                </p>
                <h1 className="workbench-title mt-2 text-page-title">
                  {formatTeamText(t(metadata.titleKey), activeTeam?.name)}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {formatTeamText(t(metadata.descriptionKey), activeTeam?.name)}
                </p>
              </div>
            </div>

            <div className="flex flex-none items-center gap-3">
              <div className="hidden text-right max-[720px]:sr-only min-[721px]:block">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {t('workspace.user.label')}
                </p>
                <p className="mt-1 max-w-[220px] truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {userLabel}
                </p>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">
                {userInitial}
              </div>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                type="button"
                onClick={onLogout}
              >
                {t('dashboard.logout')}
              </button>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <WorkspaceBody
              activeTeam={activeTeam}
              fontSizePreference={fontSizePreference}
              summary={summary}
              t={t}
              taskMoveErrorMessage={taskMoveErrorMessage}
              tasks={tasks}
              teamProjectMembers={teamProjectMembers}
              teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
              teams={teams}
              isTeamProjectMembersLoading={isTeamProjectMembersLoading}
              onFontSizePreferenceChange={onFontSizePreferenceChange}
              onMoveTaskStatus={onMoveTaskStatus}
              onOpenTask={onOpenTask}
              onSelectProject={onSelectProject}
              userIdentityAliases={userIdentityAliases}
              view={view}
            />
          </div>
        )}
      </section>
    </main>
  )
}

function WorkspaceBody({
  activeTeam,
  fontSizePreference,
  summary,
  t,
  taskMoveErrorMessage,
  tasks,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  teams,
  isTeamProjectMembersLoading,
  onFontSizePreferenceChange,
  onMoveTaskStatus,
  onOpenTask,
  onSelectProject,
  userIdentityAliases,
  view,
}: {
  activeTeam?: ProjectDirectoryTeam
  fontSizePreference: FontSizePreference
  summary: DashboardSummary
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  tasks: ProjectTask[]
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  teams: ProjectDirectoryTeam[]
  isTeamProjectMembersLoading: boolean
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  userIdentityAliases: string[]
  view: WorkspaceView
}) {
  return (
    <div className="px-[clamp(20px,3vw,34px)] py-5">
      {view === 'home' ? (
        <HomeView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'my-tasks' ? (
        <MyTasksView
          t={t}
          taskMoveErrorMessage={taskMoveErrorMessage}
          tasks={tasks}
          onMoveTaskStatus={onMoveTaskStatus}
        />
      ) : null}
      {view === 'inbox' ? (
        <InboxView
          onOpenTask={onOpenTask}
          t={t}
          tasks={tasks}
          teams={teams}
          userIdentityAliases={userIdentityAliases}
        />
      ) : null}
      {view === 'dashboard' ? (
        <DashboardWorkspaceView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'reports' ? (
        <ReportsView
          onSelectProject={onSelectProject}
          t={t}
          tasks={tasks}
          teams={teams}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'help' ? <HelpView t={t} /> : null}
      {view === 'settings' ? (
        <SettingsView
          fontSizePreference={fontSizePreference}
          t={t}
          onFontSizePreferenceChange={onFontSizePreferenceChange}
        />
      ) : null}
      {view === 'team-overview' ? (
        <TeamOverviewView
          isTeamProjectMembersLoading={isTeamProjectMembersLoading}
          t={t}
          tasks={tasks}
          team={activeTeam}
          teamProjectMembers={teamProjectMembers}
          teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
          onOpenTask={onOpenTask}
          onSelectProject={onSelectProject}
        />
      ) : null}
      {view === 'team-members' ? (
        <TeamMembersView
          isTeamProjectMembersLoading={isTeamProjectMembersLoading}
          t={t}
          tasks={tasks}
          team={activeTeam}
          teamProjectMembers={teamProjectMembers}
          teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
          onSelectProject={onSelectProject}
        />
      ) : null}
    </div>
  )
}

function HomeView({
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
}: {
  onOpenTask?: (task: ProjectTask) => void
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const nextTasks = createActionQueueTasks(tasks).slice(0, 3)
  const activityTasks = createActivityTasks(tasks)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.teams')} value={teams.length} tone="amber" />
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-6 max-[1080px]:grid-cols-1">
        <section className="workbench-panel">
          <SectionHeader title={t('workspace.home.focusTitle')} meta={t('workspace.home.focusMeta')} />
          <div className="divide-y divide-slate-100">
            {nextTasks.map((task) => (
              <TaskListRow
                key={createWorkspaceTaskKey(task)}
                t={t}
                task={task}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel">
          <SectionHeader title={t('workspace.home.activityTitle')} meta={t('workspace.home.activityMeta')} />
          <div className="grid gap-3 px-5 pb-5">
            {activityTasks.map((task) => (
              <button
                className="rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:hover:border-[var(--workbench-border)] disabled:hover:bg-white"
                disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
                key={createWorkspaceTaskKey(task)}
                onClick={() => onOpenTask?.(task)}
                type="button"
              >
                <p className="text-sm font-semibold text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {resolveTaskAssignee(task, t)} / {t(`tasks.status.${task.status}`)} / {task.dueDate}
                </p>
              </button>
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
    if (!onMoveTaskStatus || task.status === status || isLegacyWorkspaceTask(task)) {
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
    if (!canMoveTasks || isLegacyWorkspaceTask(task)) {
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
          className="workbench-badge-danger rounded-lg px-4 py-3 text-sm"
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
              className={`workbench-panel min-h-[420px] min-w-[260px] transition ${
                isDropTarget ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''
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
                  const isLegacyTask = isLegacyWorkspaceTask(task)

                  return (
                    <CompactTaskCard
                      draggable={canMoveTasks && !isMoving && !isLegacyTask}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      key={taskKey}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onStatusChange={isLegacyTask ? undefined : (nextStatus) => moveTaskToStatus(task, nextStatus)}
                    />
                  )
                })}
                {columnTasks.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
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
  onOpenTask,
  t,
  tasks,
  teams,
  userIdentityAliases,
}: {
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  userIdentityAliases: string[]
}) {
  const [activeFilter, setActiveFilter] = useState<InboxFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const inboxTasks = createInboxTasks(tasks)
  const normalizedSearchQuery = normalizeWorkspaceSearchText(searchQuery)
  const filterCounts: Record<InboxFilter, number> = {
    all: inboxTasks.length,
    mine: inboxTasks.filter((task) => isWorkspaceTaskAssignedToUser(task, userIdentityAliases)).length,
    overdue: inboxTasks.filter(isWorkspaceTaskOverdue).length,
    review: inboxTasks.filter((task) => task.status === 'review').length,
    high: inboxTasks.filter((task) => task.priority === 'high').length,
  }
  const filteredTasks = inboxTasks.filter((task) => {
    if (!matchesInboxFilter(task, activeFilter, userIdentityAliases)) {
      return false
    }

    if (!normalizedSearchQuery) {
      return true
    }

    return [
      resolveTaskTitle(task, t),
      resolveTaskAssignee(task, t),
      resolveWorkspaceProjectName(task, teams),
      task.projectId,
    ].some((value) => normalizeWorkspaceSearchText(value).includes(normalizedSearchQuery))
  })

  return (
    <div className="grid gap-5" data-testid="inbox-workbench">
      <section className="workbench-toolbar grid gap-4 p-4">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
          <label className="grid min-w-[260px] flex-1 gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('workspace.inbox.searchLabel')}
            <input
              aria-label={t('workspace.inbox.searchLabel')}
              className="workbench-input min-h-11 w-full px-3 normal-case tracking-normal"
              data-testid="inbox-search"
              placeholder={t('workspace.inbox.searchPlaceholder')}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
            {t('workspace.inbox.filteredMeta')
              .replace('{visible}', String(filteredTasks.length))
              .replace('{total}', String(inboxTasks.length))}
          </p>
        </div>

        <div
          aria-label={t('workspace.inbox.filterLabel')}
          className="flex flex-wrap gap-2"
          role="group"
        >
          {inboxFilterOptions.map((filter) => (
            <button
              aria-pressed={activeFilter === filter}
              className={`inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${
                activeFilter === filter
                  ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                  : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[var(--workbench-border-strong)] hover:text-[var(--workbench-text)]'
              }`}
              data-testid={`inbox-filter-${filter}`}
              key={filter}
              onClick={() => setActiveFilter(filter)}
              type="button"
            >
              <span>{t(`workspace.inbox.filter.${filter}`)}</span>
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs tabular-nums">
                {filterCounts[filter]}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-[1080px]:grid-cols-1">
        <section className="workbench-panel overflow-hidden">
          <SectionHeader
            title={t('workspace.inbox.queueTitle')}
            meta={t('workspace.inbox.queueMeta').replace('{count}', String(filteredTasks.length))}
          />
          <div className="divide-y divide-[var(--workbench-border)]" data-testid="inbox-task-list">
            {filteredTasks.map((task) => (
              <button
                className="grid w-full grid-cols-[minmax(220px,1fr)_minmax(170px,0.7fr)_auto] items-center gap-5 p-5 text-left transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[860px]:grid-cols-1"
                data-testid={`inbox-task-${createInboxTaskTestId(task)}`}
                disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
                key={createWorkspaceTaskKey(task)}
                onClick={() => onOpenTask?.(task)}
                type="button"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">
                    {resolveTaskTitle(task, t)}
                  </p>
                  <p className="mt-1 truncate text-sm font-medium text-[var(--workbench-muted)]">
                    {resolveWorkspaceProjectName(task, teams)} · {resolveTaskAssignee(task, t)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {createInboxReasonKeys(task).map((reasonKey) => (
                      <span className={resolveInboxReasonClassName(reasonKey)} key={reasonKey}>
                        {t(reasonKey)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={task.status} t={t} />
                  <PriorityPill priority={task.priority} t={t} />
                  <span className="text-sm font-semibold text-[var(--workbench-muted)]">{task.dueDate}</span>
                </div>
                <span className="workbench-badge justify-self-end max-[860px]:justify-self-start">
                  {t('workspace.action.openTask')}
                </span>
              </button>
            ))}
            {filteredTasks.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm font-semibold text-[var(--workbench-text)]">
                  {t('workspace.inbox.emptyTitle')}
                </p>
                <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">
                  {t('workspace.inbox.emptyDescription')}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="grid content-start gap-4">
          <section className="workbench-panel p-5">
            <p className="workbench-eyebrow">{t('workspace.inbox.breakdownTitle')}</p>
            <div className="mt-4 grid divide-y divide-[var(--workbench-border)]">
              {(['overdue', 'high', 'review', 'mine'] as const).map((filter) => (
                <div className="flex items-center justify-between gap-4 py-3" key={filter}>
                  <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                    {t(`workspace.inbox.filter.${filter}`)}
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-[var(--workbench-text)]">
                    {filterCounts[filter]}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="workbench-panel p-5">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.inbox.scopeTitle')}
            </p>
            <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('workspace.inbox.scopeDescription')}
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}

function DashboardWorkspaceView({
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
}: {
  onOpenTask?: (task: ProjectTask) => void
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const decisionTasks = createActionQueueTasks(tasks).slice(0, 5)
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
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.deliveryRate')} value={`${calculateProjectProgress(tasks)}%`} tone="amber" />
      </div>

      <section className="workbench-table overflow-hidden">
        <SectionHeader title={t('workspace.dashboard.portfolioTitle')} meta={t('workspace.dashboard.portfolioMeta')} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-left">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.slice(0, 6).map((project) => (
                <tr className="border-b border-slate-100 text-sm font-medium text-[var(--workbench-text)]" key={project.id}>
                  <td className="px-5 py-4">{project.name}</td>
                  <td className="px-5 py-4 text-[var(--workbench-muted)]">{project.teamName}</td>
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

      <section className="workbench-panel">
        <SectionHeader
          title={t('workspace.dashboard.decisionTitle')}
          meta={t('workspace.dashboard.decisionMeta').replace('{count}', String(decisionTasks.length))}
        />
        <div className="divide-y divide-slate-100">
          {decisionTasks.map((task) => (
            <TaskListRow
              key={createWorkspaceTaskKey(task)}
              t={t}
              task={task}
              onOpenTask={onOpenTask}
            />
          ))}
          {decisionTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function ReportsView({
  onOpenTask,
  onSelectProject,
  t,
  tasks,
  teams,
}: {
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [showAttentionOnly, setShowAttentionOnly] = useState(false)
  const openTasks = tasks.filter((task) => task.status !== 'done')
  const attentionTasks = createInboxTasks(tasks)
  const projectRows = createReportProjectRows(teams, tasks)
  const normalizedProjectSearchQuery = normalizeWorkspaceSearchText(projectSearchQuery)
  const filteredProjectRows = projectRows.filter((project) => {
    if (showAttentionOnly && project.attentionTaskCount === 0) {
      return false
    }

    return !normalizedProjectSearchQuery ||
      normalizeWorkspaceSearchText(`${project.name} ${project.teamName}`).includes(normalizedProjectSearchQuery)
  })
  const statusItems = reportStatusOrder.map((status) => ({
    count: tasks.filter((task) => task.status === status).length,
    id: status,
    label: t(`tasks.status.${status}`),
  }))
  const priorityItems = reportPriorityOrder.map((priority) => ({
    count: openTasks.filter((task) => task.priority === priority).length,
    id: priority,
    label: t(`tasks.priority.${priority}`),
  }))
  const attentionProjectCount = projectRows.filter((project) => project.attentionTaskCount > 0).length

  return (
    <div className="grid gap-6" data-testid="reports-workbench">
      <section className="workbench-toolbar flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.reports.snapshotTitle')}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.reports.snapshotDescription')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          data-testid="reports-export-csv"
          onClick={() => downloadWorkspaceReportCsv(filteredProjectRows, t)}
          type="button"
        >
          {t('workspace.reports.exportCsv')}
        </button>
      </section>

      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard
          label={t('workspace.reports.metric.open')}
          testId="reports-metric-open"
          value={openTasks.length}
          tone="teal"
        />
        <MetricCard
          label={t('workspace.reports.metric.completion')}
          testId="reports-metric-completion"
          value={`${calculateProjectProgress(tasks)}%`}
          tone="emerald"
        />
        <MetricCard
          label={t('workspace.reports.metric.attention')}
          testId="reports-metric-attention"
          value={attentionTasks.length}
          tone="red"
        />
        <MetricCard
          label={t('workspace.reports.metric.projects')}
          testId="reports-metric-projects"
          value={attentionProjectCount}
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-2 gap-5 max-[980px]:grid-cols-1">
        <section className="workbench-panel overflow-hidden">
          <SectionHeader
            title={t('workspace.reports.statusTitle')}
            meta={t('workspace.reports.statusMeta')}
          />
          <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
            {statusItems.map((item) => (
              <ReportDistributionRow
                count={item.count}
                key={item.id}
                label={item.label}
                toneClassName={resolveReportStatusToneClassName(item.id)}
                total={tasks.length}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel overflow-hidden">
          <SectionHeader
            title={t('workspace.reports.priorityTitle')}
            meta={t('workspace.reports.priorityMeta')}
          />
          <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
            {priorityItems.map((item) => (
              <ReportDistributionRow
                count={item.count}
                key={item.id}
                label={item.label}
                toneClassName={resolveReportPriorityToneClassName(item.id)}
                total={openTasks.length}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="workbench-table overflow-hidden">
        <div className="grid gap-4 p-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--workbench-text)]">
                {t('workspace.reports.projectsTitle')}
              </h2>
              <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
                {t('workspace.reports.projectsMeta')
                  .replace('{visible}', String(filteredProjectRows.length))
                  .replace('{total}', String(projectRows.length))}
              </p>
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={showAttentionOnly}
                className="h-4 w-4 accent-[var(--workbench-primary)]"
                data-testid="reports-attention-only"
                type="checkbox"
                onChange={(event) => setShowAttentionOnly(event.target.checked)}
              />
              {t('workspace.reports.attentionOnly')}
            </label>
          </div>
          <label className="grid max-w-[520px] gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('workspace.reports.projectSearchLabel')}
            <input
              aria-label={t('workspace.reports.projectSearchLabel')}
              className="workbench-input min-h-11 px-3 normal-case tracking-normal"
              data-testid="reports-project-search"
              placeholder={t('workspace.reports.projectSearchPlaceholder')}
              type="search"
              value={projectSearchQuery}
              onChange={(event) => setProjectSearchQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
          <table className="w-full min-w-[980px] border-collapse text-left" data-testid="reports-project-table">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.open')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.review')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.attention')}</th>
                <th className="px-5 py-3 text-right" scope="col">{t('workspace.reports.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjectRows.map((project) => (
                <tr
                  className="border-b border-[var(--workbench-border)] text-sm font-medium text-[var(--workbench-text)] last:border-b-0"
                  data-testid={`reports-project-${createWorkspaceTaskTestToken(`${project.teamId}-${project.projectId}`)}`}
                  key={`${project.teamId}-${project.projectId}`}
                >
                  <td className="px-5 py-4 font-semibold">{project.name}</td>
                  <td className="px-5 py-4 text-[var(--workbench-muted)]">{project.teamName}</td>
                  <td className="min-w-[170px] px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="min-w-[110px] flex-1">
                        <ProgressBar value={project.progress} />
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-[var(--workbench-muted)]">
                        {project.progress}%
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4 tabular-nums">{project.openTaskCount}</td>
                  <td className="px-5 py-4 tabular-nums">{project.reviewTaskCount}</td>
                  <td className="px-5 py-4">
                    <span className={project.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                      {project.attentionTaskCount}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      className="workbench-button-secondary min-h-9 px-3"
                      disabled={!onSelectProject}
                      onClick={() => onSelectProject?.(project.projectId, project.teamId)}
                      type="button"
                    >
                      {t('workspace.reports.openProject')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredProjectRows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm font-semibold text-[var(--workbench-muted)]">
              {t('workspace.reports.emptyProjects')}
            </p>
          ) : null}
        </div>
      </section>

      <section className="workbench-panel overflow-hidden">
        <SectionHeader
          title={t('workspace.reports.attentionTitle')}
          meta={t('workspace.reports.attentionMeta')}
        />
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {attentionTasks.slice(0, 6).map((task) => (
            <TaskListRow
              key={createWorkspaceTaskKey(task)}
              t={t}
              task={task}
              onOpenTask={onOpenTask}
            />
          ))}
          {attentionTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]">
              {t('workspace.empty.tasks')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function ReportDistributionRow({
  count,
  label,
  toneClassName,
  total,
}: {
  count: number
  label: string
  toneClassName: string
  total: number
}) {
  const percentage = total > 0 ? Math.round((count / total) * 100) : 0

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold text-[var(--workbench-text)]">{label}</span>
        <span className="text-sm font-semibold tabular-nums text-[var(--workbench-muted)]">
          {count} · {percentage}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--workbench-surface-muted)]">
        <div
          className={`h-full rounded-full ${toneClassName}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
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

const fontSizePreferenceLabelKeys: Record<FontSizePreference, MessageKey> = {
  compact: 'workspace.settings.fontSize.compact',
  standard: 'workspace.settings.fontSize.standard',
  comfortable: 'workspace.settings.fontSize.comfortable',
}

function SettingsView({
  fontSizePreference,
  onFontSizePreferenceChange,
  t,
}: {
  fontSizePreference: FontSizePreference
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid gap-5">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_14px_32px_rgba(30,52,88,0.05)]">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[#0d1833]">
              {t('workspace.settings.displayTitle')}
            </h2>
            <p className="mt-2 max-w-[680px] text-sm font-bold leading-6 text-[#526381]">
              {t('workspace.settings.displayDescription')}
            </p>
          </div>
          <div
            aria-label={t('workspace.settings.fontSizeTitle')}
            className="inline-flex min-h-10 overflow-hidden rounded-lg border border-slate-300 bg-white"
            data-testid="font-size-preference-control"
            role="group"
          >
            {fontSizePreferenceOptions.map((preference) => (
              <button
                aria-pressed={fontSizePreference === preference}
                className={`px-4 text-sm font-semibold transition ${
                  fontSizePreference === preference
                    ? 'bg-[var(--workbench-primary)] text-white'
                    : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]'
                }`}
                data-testid={`font-size-preference-${preference}`}
                key={preference}
                onClick={() => onFontSizePreferenceChange(preference)}
                type="button"
              >
                {t(fontSizePreferenceLabelKeys[preference])}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-5 rounded-lg border border-slate-200 bg-[#fbfdff] p-4">
          <p className="text-sm font-semibold text-[#0d1833]">
            {t('workspace.settings.fontSizeTitle')}
          </p>
          <p className="mt-2 text-sm font-bold leading-6 text-[#526381]">
            {t('workspace.settings.fontSizeDescription')}
          </p>
        </div>
      </section>
      <InfoGrid
        items={[
          ['workspace.settings.profileTitle', 'workspace.settings.profileDescription'],
          ['workspace.settings.notificationTitle', 'workspace.settings.notificationDescription'],
          ['workspace.settings.permissionTitle', 'workspace.settings.permissionDescription'],
          ['workspace.settings.integrationTitle', 'workspace.settings.integrationDescription'],
        ]}
        t={t}
      />
    </div>
  )
}

function TeamOverviewView({
  isTeamProjectMembersLoading,
  onOpenTask,
  onSelectProject,
  team,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  t,
  tasks,
}: {
  isTeamProjectMembersLoading: boolean
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  team?: ProjectDirectoryTeam
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const projects = team?.projects ?? []
  const projectIds = projects.map((project) => project.id)
  const teamTasks = filterTasksByTeamProjectIds(tasks, projectIds, team?.id)
  const projectSummaries = createTeamProjectSummaries(projects, tasks, teamProjectMembers, team?.id)
  const memberCount = countUniqueTeamMembers(teamProjectMembers)
  const attentionTaskCount = teamTasks.filter(isAttentionWorkspaceTask).length

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard
          label={t('workspace.metric.projects')}
          testId="team-overview-projects"
          value={projects.length}
          tone="teal"
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
          value={attentionTaskCount}
          tone="red"
        />
        <MetricCard
          label={t('workspace.teamOverview.memberMetric')}
          testId="team-overview-members"
          value={memberCount}
          tone="amber"
        />
      </div>

      <TeamMembersNotice
        failedProjectIds={teamProjectMembersFailedProjectIds}
        isLoading={isTeamProjectMembersLoading}
        t={t}
      />

      <section className="workbench-table overflow-hidden">
        <SectionHeader
          title={t('workspace.teamOverview.projectsTitle')}
          meta={team?.name ?? t('workspace.team.missing')}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left" data-testid="team-overview-project-table">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.open')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.review')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.attention')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.members')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.teamOverview.column.nextAction')}</th>
              </tr>
            </thead>
            <tbody>
              {projectSummaries.map((project) => (
                <tr
                  className="border-b border-slate-100 align-top text-sm font-medium text-[var(--workbench-text)] last:border-b-0"
                  data-testid={`team-overview-project-${createWorkspaceTaskTestToken(project.id)}`}
                  key={project.id}
                >
                  <td className="px-5 py-4">
                    <div className="min-w-[180px]">
                      <p className="font-semibold">{project.name}</p>
                      <button
                        className="mt-2 text-xs font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                        type="button"
                        onClick={() => {
                          if (team) {
                            onSelectProject?.(project.id, team.id)
                          }
                        }}
                      >
                        {t('workspace.teamOverview.openProject')}
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="grid min-w-[160px] gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                          {project.progress}%
                        </span>
                      </div>
                      <ProgressBar value={project.progress} />
                    </div>
                  </td>
                  <td className="px-5 py-4">{project.openTaskCount}</td>
                  <td className="px-5 py-4">{project.reviewTaskCount}</td>
                  <td className="px-5 py-4">
                    <span className={project.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                      {project.attentionTaskCount}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="grid gap-1">
                      <span>{t('workspace.teamOverview.memberCount').replace('{count}', String(project.memberCount))}</span>
                      <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                        {t('workspace.teamOverview.managerCount').replace('{count}', String(project.managerCount))}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    {project.nextTask ? (
                      <button
                        className="grid max-w-[280px] gap-1 text-left hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)]"
                        disabled={!onOpenTask || !isOpenableWorkspaceTask(project.nextTask)}
                        type="button"
                        onClick={() => onOpenTask?.(project.nextTask as ProjectTask)}
                      >
                        <span className="line-clamp-2 font-semibold">
                          {resolveTaskTitle(project.nextTask, t)}
                        </span>
                        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                          {project.nextTask.dueDate} / {t(`tasks.status.${project.nextTask.status}`)}
                        </span>
                      </button>
                    ) : (
                      <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                        {t('workspace.teamOverview.noNextAction')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {projectSummaries.length === 0 ? (
            <p className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.teamOverview.emptyProjects')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function TeamMembersView({
  isTeamProjectMembersLoading,
  onSelectProject,
  team,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  t,
  tasks,
}: {
  isTeamProjectMembersLoading: boolean
  onSelectProject?: (projectId: string, teamId: string) => void
  team?: ProjectDirectoryTeam
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<TeamMemberRoleFilter>('all')
  const projects = team?.projects ?? []
  const members = createTeamMemberRows(projects, tasks, teamProjectMembers, team?.id, t)
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const filteredMembers = members.filter((member) => {
    const matchesRole = roleFilter === 'all' || member.role === roleFilter
    const matchesSearch = normalizedSearchQuery.length === 0 ||
      member.name.toLowerCase().includes(normalizedSearchQuery) ||
      member.email.toLowerCase().includes(normalizedSearchQuery) ||
      member.projectAccess.some((project) =>
        project.projectName.toLowerCase().includes(normalizedSearchQuery),
      )

    return matchesRole && matchesSearch
  })
  const managerCount = members.filter((member) => member.role === 'manager').length
  const loadedCount = members.filter((member) => member.openTaskCount >= 3 || member.loadPercent >= 75).length
  const openTaskCount = members.reduce((total, member) => total + member.openTaskCount, 0)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.members.metric.members')} value={members.length} tone="teal" />
        <MetricCard label={t('workspace.members.metric.managers')} value={managerCount} tone="amber" />
        <MetricCard label={t('workspace.members.metric.loaded')} value={loadedCount} tone="red" />
        <MetricCard label={t('workspace.members.metric.open')} value={openTaskCount} tone="emerald" />
      </div>

      <TeamMembersNotice
        failedProjectIds={teamProjectMembersFailedProjectIds}
        isLoading={isTeamProjectMembersLoading}
        t={t}
      />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <div className="border-b border-slate-100">
          <SectionHeader title={t('workspace.members.directoryTitle')} meta={team?.name ?? t('workspace.team.missing')} />
          <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-3 px-5 pb-5 max-[760px]:grid-cols-1">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.members.searchLabel')}
              <input
                className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-[var(--workbench-text)] outline-none transition placeholder:text-slate-400 focus:border-[#6fbfb4] focus:ring-4 focus:ring-[#dff5f1]"
                data-testid="team-members-search"
                placeholder={t('workspace.members.searchPlaceholder')}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.members.roleFilter')}
              <select
                className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-[var(--workbench-text)] outline-none transition focus:border-[#6fbfb4] focus:ring-4 focus:ring-[#dff5f1]"
                data-testid="team-members-role-filter"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as TeamMemberRoleFilter)}
              >
                <option value="all">{t('workspace.members.role.all')}</option>
                <option value="manager">{t('workspace.permissions.role.manager')}</option>
                <option value="member">{t('workspace.permissions.role.member')}</option>
                <option value="viewer">{t('workspace.permissions.role.viewer')}</option>
              </select>
            </label>
          </div>
        </div>

        <div className="grid divide-y divide-slate-100" data-testid="team-members-directory">
          {filteredMembers.map((member) => (
            <div
              className="grid grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_minmax(260px,1fr)] items-center gap-5 p-5 max-[980px]:grid-cols-1"
              data-testid={`team-member-row-${createWorkspaceTaskTestToken(member.id)}`}
              key={member.id}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[#0d1833]">{member.name}</p>
                  <span className="workbench-badge">
                    {member.role ? t(`workspace.permissions.role.${member.role}`) : t('workspace.members.role.none')}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium text-[var(--workbench-muted)]">{member.email}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {member.projectAccess.map((project) => (
                    <button
                      className="rounded-full border border-[#99d7cf] bg-[#e5f7f4] px-3 py-1 text-xs font-semibold text-[var(--workbench-primary)] transition hover:bg-[#d6f0ec]"
                      data-testid={`team-member-project-${createWorkspaceTaskTestToken(member.id)}-${createWorkspaceTaskTestToken(project.projectId)}`}
                      key={project.projectId}
                      type="button"
                      onClick={() => {
                        if (team) {
                          onSelectProject?.(project.projectId, team.id)
                        }
                      }}
                    >
                      {project.projectName}
                    </button>
                  ))}
                  {member.projectAccess.length === 0 ? (
                    <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                      {t('workspace.members.noProjects')}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#69758a]">
                    {t('workspace.members.load')}
                  </p>
                  <p className="text-sm font-semibold text-[#0d1833]">{member.loadPercent}%</p>
                </div>
                <ProgressBar value={member.loadPercent} />
                <p className="text-xs font-semibold text-[var(--workbench-muted)]">
                  {member.nextDueDate
                    ? t('workspace.members.nextDue').replace('{date}', member.nextDueDate)
                    : t('workspace.members.noAssignedTasks')}
                </p>
              </div>
              <div className="grid gap-2 text-sm font-bold leading-6 text-[#526381]">
                <p>{t('workspace.members.taskCount').replace('{count}', String(member.taskCount))}</p>
                <div className="flex flex-wrap gap-2">
                  <span className="workbench-badge">
                    {t('workspace.members.openTaskCount').replace('{count}', String(member.openTaskCount))}
                  </span>
                  <span className="workbench-badge-warning">
                    {t('workspace.members.reviewTaskCount').replace('{count}', String(member.reviewTaskCount))}
                  </span>
                  <span className={member.attentionTaskCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                    {t('workspace.members.attentionTaskCount').replace('{count}', String(member.attentionTaskCount))}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {filteredMembers.length === 0 ? (
            <p className="px-5 py-8 text-sm font-bold text-[#526381]">
              {t('workspace.members.empty')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function TeamMembersNotice({
  failedProjectIds,
  isLoading,
  t,
}: {
  failedProjectIds: string[]
  isLoading: boolean
  t: (key: MessageKey) => string
}) {
  if (isLoading) {
    return (
      <p className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-sm font-semibold text-[var(--workbench-primary)]">
        {t('workspace.members.loading')}
      </p>
    )
  }

  if (failedProjectIds.length === 0) {
    return null
  }

  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
      {t('workspace.members.partialError').replace('{count}', String(failedProjectIds.length))}
    </p>
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
  tone: 'amber' | 'teal' | 'emerald' | 'red'
  value: number | string
}) {
  const toneClassNames = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    teal: 'bg-[#e5f7f4] text-[var(--workbench-primary)] border-[#99d7cf]',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  } as const

  return (
    <section
      className={`rounded-lg border bg-white p-4 shadow-[0_1px_2px_rgba(23,32,29,0.04)] ${toneClassNames[tone]}`}
      data-testid={testId}
    >
      <p className="text-xs font-semibold text-[var(--workbench-text)]">{label}</p>
      <p className="mt-2 text-3xl font-semibold leading-none text-current">{value}</p>
    </section>
  )
}

function SectionHeader({ meta, title }: { meta?: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">{title}</h2>
      {meta ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{meta}</p> : null}
    </div>
  )
}

function TaskListRow({
  onOpenTask,
  t,
  task,
}: {
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  task: ProjectTask
}) {
  const canOpenTask = Boolean(onOpenTask) && isOpenableWorkspaceTask(task)

  return (
    <button
      className="grid w-full grid-cols-[1fr_140px_110px_96px] items-center gap-4 p-5 text-left text-sm font-medium transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[900px]:grid-cols-1"
      disabled={!canOpenTask}
      onClick={() => onOpenTask?.(task)}
      type="button"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
        <p className="mt-1 text-[var(--workbench-muted)]">{resolveTaskAssignee(task, t)}</p>
      </div>
      <StatusPill status={task.status} t={t} />
      <span className="text-[var(--workbench-muted)]">{task.dueDate}</span>
      <span className="workbench-badge justify-self-end max-[900px]:justify-self-start">
        {t('workspace.action.openTask')}
      </span>
    </button>
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
        draggable ? 'cursor-grab hover:border-[#99d7cf] hover:shadow-[0_1px_2px_rgba(23,32,29,0.06)] active:cursor-grabbing' : ''
      } ${isDragging ? 'opacity-50 ring-2 ring-[#99d7cf]' : ''} ${isMoving ? 'opacity-70' : ''}`}
      data-testid={testId}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{task.dueDate}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} t={t} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
      {onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="workbench-input mt-3 h-9 w-full px-3 text-xs disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
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
    'in-progress': 'workbench-badge-primary',
    review: 'workbench-badge-warning',
    todo: 'workbench-badge',
    done: 'workbench-badge-success',
  }

  return (
    <span className={statusClasses[status]}>
      {t(`tasks.status.${status}`)}
    </span>
  )
}

function PriorityPill({ priority, t }: { priority: TaskPriority; t: (key: MessageKey) => string }) {
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }

  return (
    <span className={priorityClasses[priority]}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-[var(--workbench-primary)]" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
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
          <h2 className="text-lg font-semibold text-[#0d1833]">{t(titleKey)}</h2>
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
    projectIds.map(async (projectId) =>
      (await getProjectIssues(projectId, accessToken))
        .map((issue) => toWorkspaceTaskFromIssue(issue, projectId)),
    ),
  )

  return taskGroups.flat()
}

async function loadTeamProjectMembers(
  accessToken: string,
  projects: readonly ProjectDirectoryProject[],
): Promise<TeamProjectMembersResult> {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      members: await getProjectMembers(accessToken, project.id),
      project,
    })),
  )
  const members: TeamProjectMemberAccess[] = []
  const failedProjectIds: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      for (const member of result.value.members) {
        members.push({
          projectId: result.value.project.id,
          projectName: result.value.project.name,
          member,
        })
      }
    } else {
      const failedProjectId = projects[index]?.id

      if (failedProjectId) {
        failedProjectIds.push(failedProjectId)
      }
    }
  }

  return {
    failedProjectIds,
    members,
  }
}

async function updateWorkspaceTaskRemote(
  task: ProjectTask,
  accessToken: string,
  status: TaskStatus,
) {
  if (isLegacyWorkspaceTask(task)) {
    return task
  }

  if (task.teamId && task.source === 'dynamodb') {
    return toWorkspaceTaskFromIssue(
      await updateTeamIssue(task.teamId, task.id, accessToken, { status }),
      task.projectId,
    )
  }

  return updateProjectTaskStatus(task.projectId ?? '', task.id, accessToken, status)
}

function isLegacyWorkspaceTask(task: ProjectTask) {
  return task.source === 'legacy'
}

function toWorkspaceTaskFromIssue(issue: TeamIssue, projectId?: string): ProjectTask {
  return {
    teamId: issue.teamId,
    projectId,
    source: issue.source,
    id: issue.id,
    titleKey: issue.titleKey,
    title: issue.title,
    assigneeUserId: issue.assigneeUserId,
    assigneeEmail: issue.assigneeEmail,
    assigneeName: issue.assigneeName,
    status: issue.status,
    dueDate: issue.dueDate,
    priority: issue.priority,
  }
}

function uniqueProjectIds(teams: ProjectDirectoryTeam[]) {
  return Array.from(
    new Set(teams.flatMap((team) => team.projects.map((project) => project.id))),
  )
}

function createWorkspaceTaskKey(task: ProjectTask) {
  return `${task.teamId ?? ''}:${task.projectId ?? ''}:${task.id}`
}

function createWorkspaceTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(`${task.projectId ?? ''}:${task.id}`)
}

function createInboxTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(
    `${task.teamId ?? 'unscoped'}:${task.projectId ?? 'unscoped'}:${task.id}`,
  )
}

function createWorkspaceTaskTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
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

function filterTasksByProjectIdsStrict(tasks: ProjectTask[], projectIds: readonly string[]) {
  const projectIdSet = new Set(projectIds)

  if (projectIdSet.size === 0) {
    return []
  }

  return tasks.filter((task) => Boolean(task.projectId && projectIdSet.has(task.projectId)))
}

function filterTasksByTeamProjectIds(
  tasks: ProjectTask[],
  projectIds: readonly string[],
  teamId?: string,
) {
  return filterTasksByProjectIdsStrict(tasks, projectIds).filter(
    (task) => !teamId || !task.teamId || task.teamId === teamId,
  )
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

function createActionQueueTasks(tasks: ProjectTask[]) {
  return [...tasks]
    .filter((task) => task.status !== 'done')
    .sort((firstTask, secondTask) => {
      const firstScore = calculateWorkspaceActionScore(firstTask)
      const secondScore = calculateWorkspaceActionScore(secondTask)

      if (firstScore !== secondScore) {
        return secondScore - firstScore
      }

      return getWorkspaceDueTime(firstTask) - getWorkspaceDueTime(secondTask)
    })
}

function createInboxTasks(tasks: ProjectTask[]) {
  return createActionQueueTasks(tasks)
    .filter((task) =>
      task.priority === 'high' ||
      task.status === 'review' ||
      isWorkspaceTaskOverdue(task),
    )
}

function matchesInboxFilter(
  task: ProjectTask,
  filter: InboxFilter,
  userIdentityAliases: readonly string[],
) {
  if (filter === 'mine') {
    return isWorkspaceTaskAssignedToUser(task, userIdentityAliases)
  }

  if (filter === 'overdue') {
    return isWorkspaceTaskOverdue(task)
  }

  if (filter === 'review') {
    return task.status === 'review'
  }

  if (filter === 'high') {
    return task.priority === 'high'
  }

  return true
}

function isWorkspaceTaskAssignedToUser(
  task: ProjectTask,
  userIdentityAliases: readonly string[],
) {
  const normalizedUserAliases = new Set(
    userIdentityAliases.map(normalizeWorkspaceSearchText).filter(Boolean),
  )

  return normalizedUserAliases.size > 0 && [
    task.assigneeUserId,
    task.assigneeEmail,
  ].some((value) => normalizedUserAliases.has(normalizeWorkspaceSearchText(value)))
}

function resolveWorkspaceProjectName(task: ProjectTask, teams: ProjectDirectoryTeam[]) {
  const scopedTeam = task.teamId
    ? teams.find((team) => team.id === task.teamId)
    : undefined
  const scopedProject = scopedTeam?.projects.find((project) => project.id === task.projectId)

  if (scopedProject) {
    return scopedProject.name
  }

  return teams
    .flatMap((team) => team.projects)
    .find((project) => project.id === task.projectId)?.name ?? task.projectId ?? '-'
}

function createInboxReasonKeys(task: ProjectTask): MessageKey[] {
  const reasonKeys: MessageKey[] = []

  if (isWorkspaceTaskOverdue(task)) {
    reasonKeys.push('workspace.inbox.reason.overdue')
  }

  if (task.priority === 'high') {
    reasonKeys.push('workspace.inbox.reason.high')
  }

  if (task.status === 'review') {
    reasonKeys.push('workspace.inbox.reason.review')
  }

  return reasonKeys.length > 0 ? reasonKeys : ['workspace.inbox.reason.watch']
}

function resolveInboxReasonClassName(reasonKey: MessageKey) {
  if (reasonKey === 'workspace.inbox.reason.overdue' || reasonKey === 'workspace.inbox.reason.high') {
    return 'workbench-badge-danger'
  }

  if (reasonKey === 'workspace.inbox.reason.review') {
    return 'workbench-badge-warning'
  }

  return 'workbench-badge-primary'
}

function normalizeWorkspaceSearchText(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? ''
}

function calculateWorkspaceActionScore(task: ProjectTask) {
  return (isWorkspaceTaskOverdue(task) ? 8 : 0) +
    (task.priority === 'high' ? 5 : task.priority === 'medium' ? 2 : 0) +
    (task.status === 'review' ? 4 : task.status === 'in-progress' ? 1 : 0)
}

function isOpenableWorkspaceTask(task: ProjectTask) {
  return Boolean(task.projectId && task.teamId)
}

function isWorkspaceTaskOverdue(task: ProjectTask) {
  const dueDate = parseWorkspaceTaskDueDate(task.dueDate)

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return dueDate < today
}

function getWorkspaceDueTime(task: ProjectTask) {
  return parseWorkspaceTaskDueDate(task.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER
}

function parseWorkspaceTaskDueDate(value: string) {
  const [year, month, day] = value.split('/').map(Number)

  if (!year || !month || !day) {
    return null
  }

  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return Number.isNaN(date.getTime()) ? null : date
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

  if (tasks.every((task) => task.status === 'done')) {
    return 'workspace.risk.low'
  }

  return 'workspace.risk.clear'
}

function createReportProjectRows(teams: ProjectDirectoryTeam[], tasks: ProjectTask[]) {
  return teams
    .flatMap((team) => team.projects.map((project) => {
      const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], team.id)
      const openTaskCount = projectTasks.filter((task) => task.status !== 'done').length
      const doneTaskCount = projectTasks.filter((task) => task.status === 'done').length
      const reviewTaskCount = projectTasks.filter((task) => task.status === 'review').length
      const attentionTaskCount = createInboxTasks(projectTasks).length

      return {
        attentionTaskCount,
        doneTaskCount,
        name: project.name,
        openTaskCount,
        progress: calculateProjectProgress(projectTasks),
        projectId: project.id,
        reviewTaskCount,
        taskCount: projectTasks.length,
        teamId: team.id,
        teamName: team.name,
      }
    }))
    .sort(
      (firstProject, secondProject) =>
        secondProject.attentionTaskCount - firstProject.attentionTaskCount ||
        secondProject.openTaskCount - firstProject.openTaskCount ||
        firstProject.name.localeCompare(secondProject.name),
    )
}

function resolveReportStatusToneClassName(status: TaskStatus) {
  const toneClassNames: Record<TaskStatus, string> = {
    todo: 'bg-slate-400',
    'in-progress': 'bg-[var(--workbench-primary)]',
    review: 'bg-amber-500',
    done: 'bg-emerald-600',
  }

  return toneClassNames[status]
}

function resolveReportPriorityToneClassName(priority: TaskPriority) {
  const toneClassNames: Record<TaskPriority, string> = {
    high: 'bg-red-600',
    medium: 'bg-amber-500',
    low: 'bg-emerald-600',
  }

  return toneClassNames[priority]
}

function downloadWorkspaceReportCsv(
  projectRows: ReturnType<typeof createReportProjectRows>,
  t: (key: MessageKey) => string,
) {
  const headers = [
    t('workspace.column.project'),
    t('workspace.column.team'),
    t('workspace.reports.column.total'),
    t('workspace.reports.column.open'),
    t('workspace.reports.column.done'),
    t('workspace.reports.column.review'),
    t('workspace.reports.column.attention'),
    t('workspace.column.progress'),
  ]
  const rows = projectRows.map((project) => [
    project.name,
    project.teamName,
    project.taskCount,
    project.openTaskCount,
    project.doneTaskCount,
    project.reviewTaskCount,
    project.attentionTaskCount,
    `${project.progress}%`,
  ])
  const csv = [headers, ...rows]
    .map((row) => row.map(escapeWorkspaceCsvValue).join(','))
    .join('\n')
  const downloadUrl = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')

  link.href = downloadUrl
  link.download = 'mukuroji-project-snapshot.csv'
  link.click()
  URL.revokeObjectURL(downloadUrl)
}

function escapeWorkspaceCsvValue(value: number | string) {
  const text = String(value)
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text

  return /[",\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText
}

function createTeamProjectSummaries(
  projects: readonly ProjectDirectoryProject[],
  tasks: ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
  teamId?: string,
): TeamProjectSummary[] {
  const membersByProjectId = new Map<string, TeamProjectMemberAccess[]>()

  for (const access of teamProjectMembers) {
    membersByProjectId.set(access.projectId, [
      ...(membersByProjectId.get(access.projectId) ?? []),
      access,
    ])
  }

  return projects.map((project) => {
    const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], teamId)
    const projectMembers = membersByProjectId.get(project.id) ?? []
    const memberIds = new Set(projectMembers.map((access) => createProjectMemberIdentity(access.member)))
    const managerIds = new Set(
      projectMembers
        .filter((access) => access.member.role === 'manager')
        .map((access) => createProjectMemberIdentity(access.member)),
    )

    return {
      attentionTaskCount: projectTasks.filter(isAttentionWorkspaceTask).length,
      id: project.id,
      managerCount: managerIds.size,
      memberCount: memberIds.size,
      name: project.name,
      nextTask: createActionQueueTasks(projectTasks)[0],
      openTaskCount: projectTasks.filter((task) => task.status !== 'done').length,
      progress: calculateProjectProgress(projectTasks),
      reviewTaskCount: projectTasks.filter((task) => task.status === 'review').length,
    }
  })
}

function countUniqueTeamMembers(teamProjectMembers: readonly TeamProjectMemberAccess[]) {
  return new Set(teamProjectMembers.map((access) => createProjectMemberIdentity(access.member))).size
}

function createTeamMemberRows(
  projects: readonly ProjectDirectoryProject[],
  tasks: ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
  teamId: string | undefined,
  t: (key: MessageKey) => string,
): TeamMemberRow[] {
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
  const projectIds = projects.map((project) => project.id)
  const rowsByMemberId = new Map<string, TeamMemberRow>()

  for (const access of teamProjectMembers) {
    const memberId = createProjectMemberIdentity(access.member)
    const row = rowsByMemberId.get(memberId) ?? createTeamMemberRow(access.member)
    const existingProjectAccess = row.projectAccess.find((project) => project.projectId === access.projectId)

    row.role = selectStrongerProjectMemberRole(row.role, access.member.role)

    if (existingProjectAccess) {
      existingProjectAccess.role = selectStrongerProjectMemberRole(existingProjectAccess.role, access.member.role)
    } else {
      row.projectAccess.push({
        projectId: access.projectId,
        projectName: access.projectName,
        role: access.member.role,
      })
    }

    rowsByMemberId.set(memberId, row)
  }

  const memberAliases = createTeamMemberAliasMap(rowsByMemberId)
  const tasksByMemberId = new Map<string, ProjectTask[]>()

  for (const task of filterTasksByTeamProjectIds(tasks, projectIds, teamId)) {
    const memberId = resolveTaskMemberId(task, memberAliases, t)
    const row = memberId ? rowsByMemberId.get(memberId) : undefined

    if (!row || !task.projectId || !row.projectAccess.some((project) => project.projectId === task.projectId)) {
      continue
    }

    tasksByMemberId.set(row.id, [...(tasksByMemberId.get(row.id) ?? []), task])
  }

  return Array.from(rowsByMemberId.values())
    .map((row) => {
      const memberTasks = tasksByMemberId.get(row.id) ?? []
      const openTaskCount = memberTasks.filter((task) => task.status !== 'done').length
      const nextDueDate = memberTasks
        .map((task) => task.dueDate)
        .sort((firstDate, secondDate) => firstDate.localeCompare(secondDate))[0]

      return {
        ...row,
        attentionTaskCount: memberTasks.filter(isAttentionWorkspaceTask).length,
        loadPercent: Math.round((openTaskCount / Math.max(1, memberTasks.length)) * 100),
        nextDueDate,
        openTaskCount,
        projectAccess: row.projectAccess.sort(
          (firstProject, secondProject) =>
            (projectOrder.get(firstProject.projectId) ?? Number.MAX_SAFE_INTEGER) -
              (projectOrder.get(secondProject.projectId) ?? Number.MAX_SAFE_INTEGER) ||
            firstProject.projectName.localeCompare(secondProject.projectName),
        ),
        reviewTaskCount: memberTasks.filter((task) => task.status === 'review').length,
        taskCount: memberTasks.length,
      }
    })
    .sort(
      (firstMember, secondMember) =>
        secondMember.openTaskCount - firstMember.openTaskCount ||
        getProjectMemberRoleWeight(secondMember.role) - getProjectMemberRoleWeight(firstMember.role) ||
        firstMember.name.localeCompare(secondMember.name),
    )
}

function createTeamMemberRow(member: ProjectMember): TeamMemberRow {
  return {
    attentionTaskCount: 0,
    email: member.email,
    id: createProjectMemberIdentity(member),
    loadPercent: 0,
    name: member.name?.trim() || member.email || member.id,
    openTaskCount: 0,
    projectAccess: [],
    reviewTaskCount: 0,
    role: member.role,
    taskCount: 0,
  }
}

function createTeamMemberAliasMap(rowsByMemberId: Map<string, TeamMemberRow>) {
  const aliases = new Map<string, string>()

  for (const row of rowsByMemberId.values()) {
    for (const value of [row.id, row.email, row.name]) {
      const alias = normalizeTeamMemberAlias(value)

      if (alias) {
        aliases.set(alias, row.id)
      }
    }
  }

  return aliases
}

function resolveTaskMemberId(
  task: ProjectTask,
  memberAliases: Map<string, string>,
  t: (key: MessageKey) => string,
) {
  const taskAliases = [
    task.assigneeUserId,
    task.assigneeEmail,
    task.assigneeName,
    task.assignee,
    task.assigneeKey ? t(task.assigneeKey) : undefined,
  ]

  for (const value of taskAliases) {
    const memberId = memberAliases.get(normalizeTeamMemberAlias(value))

    if (memberId) {
      return memberId
    }
  }

  return undefined
}

function createProjectMemberIdentity(member: ProjectMember) {
  return normalizeTeamMemberAlias(member.id || member.email) || member.id || member.email
}

function normalizeTeamMemberAlias(value?: string) {
  return value?.trim().toLowerCase() ?? ''
}

function selectStrongerProjectMemberRole(
  currentRole: ProjectMemberRole | undefined,
  nextRole: ProjectMemberRole,
) {
  return getProjectMemberRoleWeight(nextRole) > getProjectMemberRoleWeight(currentRole)
    ? nextRole
    : currentRole ?? nextRole
}

function getProjectMemberRoleWeight(role?: ProjectMemberRole) {
  const roleWeights: Record<ProjectMemberRole, number> = {
    manager: 3,
    member: 2,
    viewer: 1,
  }

  return role ? roleWeights[role] : 0
}

function isAttentionWorkspaceTask(task: ProjectTask) {
  return task.status !== 'done' && (task.priority === 'high' || isWorkspaceTaskOverdue(task))
}

function formatTeamText(value: string, teamName?: string) {
  return value.replace('{team}', teamName ?? '')
}
