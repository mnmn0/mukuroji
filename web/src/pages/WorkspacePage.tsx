import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import useSWR from 'swr'
import {
  getCurrentUser,
  getDashboardSummary,
  type DashboardSummary,
} from '../auth/api'
import { clearAuthSession, getAuthSession, type AuthSession } from '../auth/session'
import {
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
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../projects/api'
import { projectDirectoryFixtures } from '../projects/fixtures'
import {
  createProjectTasksPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import type { ProjectTask, TaskPriority, TaskStatus } from '../tasks/api'
import { referoTaskFixtures } from '../tasks/fixtures'

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

const fallbackDashboardSummary: DashboardSummary = {
  projects: 9,
  tasks: 27,
  blocked: 3,
  updatedAt: '2026-06-03T00:00:00.000Z',
  source: 'dynamodb',
}

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

const inboxItems = [
  {
    id: 'approval',
    titleKey: 'workspace.inbox.item.approval',
    metaKey: 'workspace.inbox.item.approvalMeta',
    toneClassName: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  {
    id: 'mention',
    titleKey: 'workspace.inbox.item.mention',
    metaKey: 'workspace.inbox.item.mentionMeta',
    toneClassName: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  {
    id: 'risk',
    titleKey: 'workspace.inbox.item.risk',
    metaKey: 'workspace.inbox.item.riskMeta',
    toneClassName: 'border-red-200 bg-red-50 text-red-700',
  },
] as const

const activityItems = [
  {
    id: 'handoff',
    titleKey: 'workspace.activity.handoff',
    metaKey: 'workspace.activity.handoffMeta',
  },
  {
    id: 'approval',
    titleKey: 'workspace.activity.approval',
    metaKey: 'workspace.activity.approvalMeta',
  },
  {
    id: 'blocker',
    titleKey: 'workspace.activity.blocker',
    metaKey: 'workspace.activity.blockerMeta',
  },
] as const

const reportTrendItems = [
  { id: 'mon', labelKey: 'workspace.reports.day.mon', value: 42 },
  { id: 'tue', labelKey: 'workspace.reports.day.tue', value: 58 },
  { id: 'wed', labelKey: 'workspace.reports.day.wed', value: 73 },
  { id: 'thu', labelKey: 'workspace.reports.day.thu', value: 64 },
  { id: 'fri', labelKey: 'workspace.reports.day.fri', value: 81 },
] as const

const teamMemberItems = [
  {
    id: 'sato',
    nameKey: 'tasks.assignee.sato',
    roleKey: 'workspace.members.role.pm',
    load: 82,
    focusKey: 'workspace.members.focus.launch',
  },
  {
    id: 'suzuki',
    nameKey: 'tasks.assignee.suzuki',
    roleKey: 'workspace.members.role.design',
    load: 68,
    focusKey: 'workspace.members.focus.design',
  },
  {
    id: 'tanaka',
    nameKey: 'tasks.assignee.tanaka',
    roleKey: 'workspace.members.role.engineering',
    load: 74,
    focusKey: 'workspace.members.focus.delivery',
  },
  {
    id: 'yamamoto',
    nameKey: 'tasks.assignee.yamamoto',
    roleKey: 'workspace.members.role.analysis',
    load: 55,
    focusKey: 'workspace.members.focus.research',
  },
] as const

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
  const dashboardSummaryKey = accessToken && user && !currentUserError
    ? (['dashboard-summary', accessToken] as const)
    : null
  const { data: summary = fallbackDashboardSummary } = useSWR(
    dashboardSummaryKey,
    ([, currentAccessToken]) => getDashboardSummary(currentAccessToken),
    apiSWRConfig,
  )
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const { data: teams = projectDirectoryFixtures } = useSWR(
    projectDirectoryKey,
    ([, currentAccessToken, currentLocale]) =>
      getProjectDirectory(currentAccessToken, currentLocale),
    apiSWRConfig,
  )
  const metadata = workspaceViewMetadata[view]
  const title = t(metadata.titleKey)
  const userLabel =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const isLoading = !session || isCurrentUserLoading || Boolean(currentUserError)

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
      summary={summary}
      tasks={referoTaskFixtures}
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
}: WorkspaceScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const metadata = workspaceViewMetadata[view]
  const activeTeam = findActiveTeam(teams, activeTeamId)

  return (
    <main className="flex min-h-svh overflow-hidden bg-[#f5f8fc] text-[#0d1833]">
      <Sidebar
        activeNavId={metadata.activeNavId}
        activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
        activeTeamViewId={metadata.activeTeamViewId}
        className="max-[980px]:hidden"
        inboxCount={3}
        labels={sidebarLabels}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />

      <section className="min-w-0 flex-1 overflow-auto">
        <header className="border-b border-slate-200 bg-white px-[clamp(22px,3vw,40px)] py-6">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-5">
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
      {view === 'inbox' ? <InboxView t={t} /> : null}
      {view === 'dashboard' ? (
        <DashboardWorkspaceView summary={summary} t={t} teams={teams} />
      ) : null}
      {view === 'reports' ? <ReportsView summary={summary} t={t} /> : null}
      {view === 'invite' ? <InviteView t={t} /> : null}
      {view === 'help' ? <HelpView t={t} /> : null}
      {view === 'settings' ? <SettingsView t={t} /> : null}
      {view === 'team-overview' ? (
        <TeamOverviewView team={activeTeam} t={t} tasks={tasks} />
      ) : null}
      {view === 'team-members' ? <TeamMembersView team={activeTeam} t={t} /> : null}
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
              <TaskListRow key={task.id} t={t} task={task} />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
          <SectionHeader title={t('workspace.home.activityTitle')} meta={t('workspace.home.activityMeta')} />
          <div className="grid gap-3 px-5 pb-5">
            {activityItems.map((item) => (
              <div className="rounded-lg border border-slate-200 bg-[#fbfdff] p-4" key={item.id}>
                <p className="text-sm font-black text-[#0d1833]">{t(item.titleKey)}</p>
                <p className="mt-1 text-sm font-bold leading-6 text-[#526381]">{t(item.metaKey)}</p>
              </div>
            ))}
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
              <CompactTaskCard key={task.id} t={t} task={task} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function InboxView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1080px]:grid-cols-1">
      <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader title={t('workspace.inbox.queueTitle')} meta={t('workspace.inbox.queueMeta')} />
        <div className="divide-y divide-slate-100">
          {inboxItems.map((item) => (
            <div className="grid gap-3 p-5" key={item.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-base font-black text-[#0d1833]">{t(item.titleKey)}</p>
                  <p className="mt-1 text-sm font-bold leading-6 text-[#526381]">{t(item.metaKey)}</p>
                </div>
                <span className={`rounded-lg border px-3 py-1.5 text-xs font-black ${item.toneClassName}`}>
                  {t('workspace.inbox.needsAction')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <p className="text-sm font-black uppercase tracking-normal text-blue-600">
          {t('workspace.inbox.sla')}
        </p>
        <p className="mt-4 text-5xl font-black leading-none text-[#0d1833]">18m</p>
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
  teams,
}: {
  summary: DashboardSummary
  t: (key: MessageKey) => string
  teams: ProjectDirectoryTeam[]
}) {
  const projects = teams.flatMap((team) =>
    team.projects.map((project, index) => ({
      id: `${team.id}-${project.id}`,
      name: project.name,
      teamName: team.name,
      progress: 88 - index * 13,
      riskKey: resolvePortfolioRiskKey(index),
    })),
  )

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="blue" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.deliveryRate')} value="84%" tone="amber" />
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
}: {
  summary: DashboardSummary
  t: (key: MessageKey) => string
}) {
  const availableThroughput = Math.max(0, summary.tasks - summary.blocked)
  const blockedRate = summary.tasks > 0
    ? Math.round((summary.blocked / summary.tasks) * 100)
    : 0

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
              <p className="text-center text-sm font-black text-[#526381]">{t(item.labelKey)}</p>
            </div>
          ))}
        </div>
      </section>

      <aside className="grid gap-4">
        <MetricCard label={t('workspace.reports.throughput')} value={availableThroughput} tone="emerald" />
        <MetricCard label={t('workspace.reports.blockedRate')} value={`${blockedRate}%`} tone="red" />
        <MetricCard label={t('workspace.reports.cycleTime')} value="3.8d" tone="amber" />
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

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.projects')} value={projects.length} tone="blue" />
        <MetricCard label={t('workspace.metric.openTasks')} value={tasks.filter((task) => task.status !== 'done').length} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={tasks.filter((task) => task.priority === 'high').length} tone="red" />
      </div>
      <section className="rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
        <SectionHeader title={t('workspace.teamOverview.projectsTitle')} meta={team?.name ?? t('workspace.team.missing')} />
        <div className="grid gap-3 p-5">
          {projects.map((project, index) => (
            <div className="grid gap-3 rounded-lg border border-slate-200 p-4" key={project.id}>
              <div className="flex items-center justify-between gap-4">
                <p className="font-black text-[#0d1833]">{project.name}</p>
                <span className="text-sm font-black text-blue-600">{82 - index * 9}%</span>
              </div>
              <ProgressBar value={82 - index * 9} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function TeamMembersView({ team, t }: { team?: ProjectDirectoryTeam; t: (key: MessageKey) => string }) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_18px_42px_rgba(30,52,88,0.05)]">
      <SectionHeader title={t('workspace.members.directoryTitle')} meta={team?.name ?? t('workspace.team.missing')} />
      <div className="grid divide-y divide-slate-100">
        {teamMemberItems.map((member) => (
          <div className="grid grid-cols-[1fr_160px_220px] items-center gap-5 p-5 max-[820px]:grid-cols-1" key={member.id}>
            <div className="min-w-0">
              <p className="text-base font-black text-[#0d1833]">{t(member.nameKey)}</p>
              <p className="mt-1 text-sm font-bold text-[#526381]">{t(member.roleKey)}</p>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-normal text-[#69758a]">
                {t('workspace.members.load')}
              </p>
              <p className="mt-1 text-2xl font-black text-[#0d1833]">{member.load}%</p>
            </div>
            <p className="text-sm font-bold leading-6 text-[#526381]">{t(member.focusKey)}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function MetricCard({
  label,
  tone,
  value,
}: {
  label: string
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
    <section className={`rounded-lg border bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.05)] ${toneClassNames[tone]}`}>
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
        <p className="truncate text-base font-black text-[#0d1833]">{t(task.titleKey)}</p>
        <p className="mt-1 text-[#526381]">{t(task.assigneeKey)}</p>
      </div>
      <StatusPill status={task.status} t={t} />
      <span className="text-[#526381]">{task.dueDate}</span>
    </div>
  )
}

function CompactTaskCard({ t, task }: { t: (key: MessageKey) => string; task: ProjectTask }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-[#fbfdff] p-4">
      <p className="text-sm font-black leading-6 text-[#0d1833]">{t(task.titleKey)}</p>
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

function resolvePortfolioRiskKey(index: number): MessageKey {
  if (index === 0) {
    return 'workspace.risk.low'
  }

  if (index === 1) {
    return 'workspace.risk.watch'
  }

  return 'workspace.risk.clear'
}

function formatTeamText(value: string, teamName?: string) {
  return value.replace('{team}', teamName ?? '')
}
