import { useEffect, useMemo, useState } from 'react'
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
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  getProjectDirectory,
  type ProjectDirectoryTeam,
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
  | 'invite'
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
  invite: {
    activeNavId: 'invite',
    eyebrowKey: 'workspace.invite.eyebrow',
    titleKey: 'workspace.invite.title',
    descriptionKey: 'workspace.invite.description',
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
  const projectTasksKey =
    accessToken && user && !currentUserError && projectIds.length > 0
      ? (['workspace-project-tasks', accessToken, projectIds] as const)
      : null
  const { data: tasks = emptyProjectTasks, isLoading: isProjectTasksLoading } = useSWR(
    projectTasksKey,
    ([, currentAccessToken, currentProjectIds]) =>
      loadProjectTasks(currentProjectIds, currentAccessToken),
    apiSWRConfig,
  )
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
      summary={summary}
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
  isLoading = false,
  onLogout,
  onSelectNav,
  onSelectTeamView,
  onSelectProject,
  onCreateProject,
  onCreateTeam,
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
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />

      <MobileSidebarDrawer
        closeLabel={t('sidebar.mobileClose')}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
      >
        <Sidebar
          activeNavId={metadata.activeNavId}
          activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
          activeTeamViewId={metadata.activeTeamViewId}
          inboxCount={createInboxTasks(tasks).length}
          labels={sidebarLabels}
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
            summary={summary}
            t={t}
            tasks={tasks}
            teams={teams}
            view={view}
          />
        )}
      </section>
    </main>
  )
}

function WorkspaceBody({
  activeTeam,
  summary,
  t,
  tasks,
  teams,
  view,
}: {
  activeTeam?: ProjectDirectoryTeam
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  view: WorkspaceView
}) {
  return (
    <div className="px-[clamp(22px,3vw,40px)] py-7">
      {view === 'home' ? <HomeView summary={summary} t={t} tasks={tasks} teams={teams} /> : null}
      {view === 'my-tasks' ? <MyTasksView t={t} tasks={tasks} /> : null}
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
      {view === 'invite' ? <InviteView t={t} /> : null}
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

function MyTasksView({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const groupedTasks = [
    {
      id: 'today',
      titleKey: 'workspace.myTasks.group.today',
      tasks: tasks.filter((task) => task.priority === 'high' || task.status === 'review'),
    },
    {
      id: 'upcoming',
      titleKey: 'workspace.myTasks.group.upcoming',
      tasks: tasks.filter((task) => task.priority !== 'high' && task.status !== 'done'),
    },
    {
      id: 'done',
      titleKey: 'workspace.myTasks.group.done',
      tasks: tasks.filter((task) => task.status === 'done'),
    },
  ] as const

  return (
    <div className="grid grid-cols-3 gap-5 max-[1080px]:grid-cols-1">
      {groupedTasks.map((group) => (
        <section
          className="min-h-[360px] rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]"
          key={group.id}
        >
          <SectionHeader
            title={t(group.titleKey)}
            meta={t('tasks.count').replace('{count}', String(group.tasks.length))}
          />
          <div className="grid gap-3 px-5 pb-5">
            {group.tasks.map((task) => (
              <CompactTaskCard key={createWorkspaceTaskKey(task)} t={t} task={task} />
            ))}
          </div>
        </section>
      ))}
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

function InviteView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="grid max-w-[920px] gap-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm font-black text-[#263550]" htmlFor="invite-email">
            {t('workspace.invite.emailLabel')}
            <input
              className="h-12 rounded-lg border border-slate-300 px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              id="invite-email"
              placeholder={t('workspace.invite.emailPlaceholder')}
              type="email"
            />
          </label>
          <label className="grid gap-2 text-sm font-black text-[#263550]" htmlFor="invite-role">
            {t('workspace.invite.roleLabel')}
            <select
              className="h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              id="invite-role"
            >
              <option>{t('workspace.invite.role.member')}</option>
              <option>{t('workspace.invite.role.manager')}</option>
              <option>{t('workspace.invite.role.viewer')}</option>
            </select>
          </label>
          <button
            className="h-12 w-fit rounded-lg bg-blue-600 px-5 text-sm font-black text-white shadow-[0_14px_30px_rgba(37,99,235,0.22)] transition hover:bg-blue-500"
            type="button"
          >
            {t('workspace.invite.send')}
          </button>
        </div>
      </section>
      <InfoGrid
        items={[
          ['workspace.invite.policyTitle', 'workspace.invite.policyDescription'],
          ['workspace.invite.pendingTitle', 'workspace.invite.pendingDescription'],
          ['workspace.invite.auditTitle', 'workspace.invite.auditDescription'],
        ]}
        t={t}
      />
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

function CompactTaskCard({ t, task }: { t: (key: MessageKey) => string; task: ProjectTask }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-[#fbfdff] p-4">
      <p className="text-sm font-black leading-6 text-[#0d1833]">{resolveTaskTitle(task, t)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill status={task.status} t={t} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
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

async function loadProjectTasks(projectIds: readonly string[], accessToken: string) {
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

function createWorkspaceTaskKey(task: ProjectTask) {
  return task.projectId ? `${task.projectId}:${task.id}` : task.id
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
  return task.assignee ?? (task.assigneeKey ? t(task.assigneeKey) : '')
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
