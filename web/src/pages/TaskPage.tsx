import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import useSWR from 'swr'
import { getCurrentUser } from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import { ChevronIcon } from '../components/icons'
import { Sidebar } from '../components/sidebar'
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
import {
  getProjectTasks,
  type ProjectTask,
  type TaskPriority,
  type TaskStatus,
} from '../tasks/api'

const taskTabs = ['table', 'board', 'gantt', 'calendar', 'file'] as const
const taskStatuses = ['in-progress', 'review', 'todo', 'done'] as const
const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * タスク画面で切り替えられるビュー種別です。
 */
type TaskTab = (typeof taskTabs)[number]

/**
 * ステータス絞り込みの選択値です。
 */
type StatusFilter = TaskStatus | 'all'

/**
 * 上部の進捗サマリーに表示する指標です。
 */
type ProjectMetric = {
  /**
   * 指標ラベルを解決する i18n key です。
   */
  labelKey: MessageKey
  /**
   * 指標値として表示する文字列です。
   */
  value: string
  /**
   * 指標バーの進捗率です。
   */
  progressPercent: number
  /**
   * 下線アクセントに使う Tailwind class です。
   */
  accentClassName: string
}

/**
 * タスク専用画面を描画するための props です。
 */
type TaskScreenProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のプロジェクト ID です。
   */
  projectId: string
  /**
   * ユーザーアバターに表示する頭文字です。
   */
  userInitial: string
  /**
   * サイドバーとヘッダーに表示するチーム/プロジェクト階層です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示中プロジェクトの名前です。
   */
  projectName?: string
  /**
   * 表示中プロジェクトが所属する代表チーム名です。
   */
  teamName?: string
  /**
   * 表示中プロジェクトが選択されたチーム ID です。
   */
  activeProjectTeamId?: string
  /**
   * 認証またはタスク取得中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * DynamoDB から取得したタスク一覧です。
   */
  tasks?: ProjectTask[]
  /**
   * タスク一覧の取得失敗時に表示するエラーメッセージです。
   */
  taskErrorMessage?: string
  /**
   * サイドバーからプロジェクトを選択したときの callback です。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
}

const viewLabelKeys: Record<TaskTab, MessageKey> = {
  table: 'tasks.view.table',
  board: 'tasks.view.board',
  gantt: 'tasks.view.gantt',
  calendar: 'tasks.view.calendar',
  file: 'tasks.view.file',
}

/**
 * Cognito 認証後に表示するタスク専用ページです。
 */
export function TaskPage() {
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? 'refero'
  const selectedTeamId = searchParams.get('teamId') ?? undefined
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(currentUserKey, ([, accessToken]) => getCurrentUser(accessToken), apiSWRConfig)
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const { data: teams = [] } = useSWR(
    projectDirectoryKey,
    ([, accessToken, currentLocale]) =>
      getProjectDirectory(accessToken, currentLocale),
    apiSWRConfig,
  )
  const projectTasksKey = accessToken && user && !currentUserError
    ? (['project-tasks', accessToken, projectId] as const)
    : null
  const {
    data: tasks = [],
    error: taskError,
    isLoading: isProjectTasksLoading,
  } = useSWR(
    projectTasksKey,
    ([, accessToken, currentProjectId]) =>
      getProjectTasks(currentProjectId, accessToken),
    apiSWRConfig,
  )
  const activeTeam = findTeamForProject(teams, projectId, selectedTeamId)
  const activeProject = findProjectInTeams(teams, projectId, activeTeam?.id ?? selectedTeamId)
  const projectName =
    activeProject?.name ?? (projectId === 'refero' ? t('tasks.project.refero') : projectId)
  const taskErrorMessage = useMemo(() => {
    if (!taskError) {
      return undefined
    }

    const message = taskError instanceof Error ? taskError.message : 'tasks.error.loading'

    return message === 'tasks.error.loading' ? t('tasks.error.loading') : message
  }, [taskError, t])
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

  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'

  return (
    <TaskScreen
      isLoading={isLoading}
      locale={locale}
      activeProjectTeamId={activeTeam?.id}
      onSelectProject={(nextProjectId, teamId) =>
        navigate(createProjectTasksPath(nextProjectId, teamId))
      }
      projectId={projectId}
      projectName={projectName}
      taskErrorMessage={taskErrorMessage}
      tasks={tasks}
      teamName={activeTeam?.name}
      teams={teams}
      userInitial={userInitial}
    />
  )
}

/**
 * サイドバー、プロジェクトヘッダー、タスクテーブルを含むタスク管理画面です。
 */
export function TaskScreen({
  locale,
  projectId,
  userInitial,
  teams,
  projectName,
  teamName,
  activeProjectTeamId,
  isLoading = false,
  tasks = [],
  taskErrorMessage,
  onSelectProject,
}: TaskScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const [activeTab, setActiveTab] = useState<TaskTab>('table')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const resolvedProjectName = projectName ?? projectId
  const resolvedActiveTeam = findTeamForProject(teams, projectId, activeProjectTeamId)
  const resolvedActiveTeamId = activeProjectTeamId ?? resolvedActiveTeam?.id
  const resolvedTeamName = teamName ?? resolvedActiveTeam?.name ?? ''
  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const matchesStatus = statusFilter === 'all' || task.status === statusFilter
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return [
          t(task.titleKey),
          t(task.assigneeKey),
          t(`tasks.status.${task.status}`),
          t(`tasks.priority.${task.priority}`),
          task.dueDate,
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      }),
    [searchQuery, statusFilter, t, tasks],
  )

  const updateTaskSelection = (taskId: string, selected: boolean) => {
    setSelectedTaskIds((currentTaskIds) =>
      selected
        ? [...new Set([...currentTaskIds, taskId])]
        : currentTaskIds.filter((currentTaskId) => currentTaskId !== taskId),
    )
  }

  return (
    <main className="flex min-h-svh overflow-hidden bg-[#f6f9fd] text-[#0d1833]">
      <Sidebar
        activeProjectId={projectId}
        activeProjectTeamId={resolvedActiveTeamId}
        className="max-[980px]:hidden"
        collapsed={sidebarCollapsed}
        inboxCount={3}
        labels={sidebarLabels}
        onCollapsedChange={setSidebarCollapsed}
        onSelectProject={onSelectProject}
        teams={teams}
      />

      <section className="flex min-w-0 flex-1 flex-col bg-white/80">
        <TaskHeader
          activeTab={activeTab}
          onTabChange={setActiveTab}
          projectName={resolvedProjectName}
          t={t}
          tasks={tasks}
          teamName={resolvedTeamName}
          userInitial={userInitial}
        />

        {isLoading ? (
          <div className="grid min-h-[360px] place-items-center px-6 text-base font-bold text-slate-500">
            {t('tasks.loading')}
          </div>
        ) : (
          <TaskWorkspace
            activeTab={activeTab}
            isStatusMenuOpen={isStatusMenuOpen}
            onSearchQueryChange={setSearchQuery}
            onStatusFilterChange={(nextStatusFilter) => {
              setStatusFilter(nextStatusFilter)
              setIsStatusMenuOpen(false)
            }}
            onStatusMenuOpenChange={setIsStatusMenuOpen}
            onTaskSelectionChange={updateTaskSelection}
            searchQuery={searchQuery}
            selectedTaskIds={selectedTaskIds}
            statusFilter={statusFilter}
            t={t}
            taskErrorMessage={taskErrorMessage}
            tasks={visibleTasks}
          />
        )}
      </section>
    </main>
  )
}

function findProjectInTeams(
  teams: ProjectDirectoryTeam[],
  projectId: string,
  preferredTeamId?: string,
) {
  const preferredTeam = preferredTeamId
    ? teams.find((team) => team.id === preferredTeamId)
    : undefined
  const preferredProject = preferredTeam?.projects.find((candidate) => candidate.id === projectId)

  if (preferredProject) {
    return preferredProject
  }

  for (const team of teams) {
    const project = team.projects.find((candidate) => candidate.id === projectId)

    if (project) {
      return project
    }
  }

  return undefined
}

function findTeamForProject(
  teams: ProjectDirectoryTeam[],
  projectId: string,
  preferredTeamId?: string,
) {
  const preferredTeam = preferredTeamId
    ? teams.find((team) => team.id === preferredTeamId)
    : undefined

  if (preferredTeam?.projects.some((project) => project.id === projectId)) {
    return preferredTeam
  }

  return teams.find((team) => team.projects.some((project) => project.id === projectId))
}

function createProjectTasksPath(projectId: string, teamId: string) {
  return `/projects/${encodeURIComponent(projectId)}/tasks?teamId=${encodeURIComponent(teamId)}`
}

function TaskHeader({
  activeTab,
  onTabChange,
  projectName,
  t,
  tasks,
  teamName,
  userInitial,
}: {
  activeTab: TaskTab
  onTabChange: (tab: TaskTab) => void
  projectName: string
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teamName: string
  userInitial: string
}) {
  return (
    <header className="border-b border-slate-200/80 bg-white/95 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="flex min-h-[90px] items-center justify-between gap-5 px-[clamp(22px,3vw,38px)] py-4">
        <div className="min-w-0">
          <nav
            aria-label={t('tasks.breadcrumb.aria')}
            className="flex flex-wrap items-center gap-3 text-[15px] font-medium text-[#405174]"
          >
            <span>{teamName || t('sidebar.projectGroup')}</span>
            <ChevronIcon className="h-4 w-4 -rotate-90 text-[#61708f]" />
            <span className="inline-flex items-center gap-2 font-black text-[#0d1833]">
              <ProjectGlyph />
              {projectName}
            </span>
          </nav>
          <div className="mt-3 flex min-w-0 items-center gap-4">
            <h1
              className="truncate text-[clamp(30px,3vw,42px)] font-black leading-none tracking-normal text-[#0d1833]"
              data-testid="tasks-heading"
            >
              {projectName}
            </h1>
            <IconButton label={t('tasks.action.favorite')}>
              <StarIcon />
            </IconButton>
            <IconButton label={t('tasks.action.more')}>
              <MoreIcon />
            </IconButton>
          </div>
        </div>

        <div className="flex flex-none items-center gap-3 max-[860px]:hidden">
          <button
            className="inline-flex h-12 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-black text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600"
            type="button"
          >
            <UsersMiniIcon />
            {t('tasks.action.share')}
          </button>
          <button
            className="inline-flex h-12 items-center gap-3 rounded-lg bg-blue-600 px-5 text-sm font-black text-white shadow-[0_14px_30px_rgba(37,99,235,0.28)] transition hover:bg-blue-500"
            type="button"
          >
            <PlusIcon />
            {t('tasks.action.newTask')}
            <ChevronIcon className="h-4 w-4" />
          </button>
          <IconButton label={t('tasks.action.notifications')} rounded>
            <BellOutlineIcon />
          </IconButton>
          <div
            aria-label={t('tasks.userAvatar')}
            className="grid h-12 w-12 place-items-center rounded-full bg-blue-100 text-base font-black text-blue-700"
          >
            {userInitial}
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-5 overflow-x-auto px-[clamp(22px,3vw,38px)]">
        <div aria-label={t('tasks.view.table')} className="flex min-w-max items-center gap-1" role="tablist">
          {taskTabs.map((tab) => (
            <button
              aria-selected={activeTab === tab}
              className={`relative inline-flex h-[76px] items-center gap-2 px-5 text-sm font-black transition ${
                activeTab === tab ? 'text-blue-600' : 'text-[#405174] hover:text-blue-600'
              }`}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              type="button"
            >
              <TabIcon tab={tab} />
              {t(`tasks.tab.${tab}`)}
              {activeTab === tab ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 bottom-0 h-1 rounded-t-full bg-blue-600"
                />
              ) : null}
            </button>
          ))}
        </div>
        <SummaryCard t={t} tasks={tasks} />
      </div>
    </header>
  )
}

function TaskWorkspace({
  activeTab,
  isStatusMenuOpen,
  onSearchQueryChange,
  onStatusFilterChange,
  onStatusMenuOpenChange,
  onTaskSelectionChange,
  searchQuery,
  selectedTaskIds,
  statusFilter,
  t,
  taskErrorMessage,
  tasks,
}: {
  activeTab: TaskTab
  isStatusMenuOpen: boolean
  onSearchQueryChange: (query: string) => void
  onStatusFilterChange: (statusFilter: StatusFilter) => void
  onStatusMenuOpenChange: (isOpen: boolean) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  searchQuery: string
  selectedTaskIds: string[]
  statusFilter: StatusFilter
  t: (key: MessageKey) => string
  taskErrorMessage?: string
  tasks: ProjectTask[]
}) {
  const statusFilterButtonId = 'status-filter-button'
  const statusFilterMenuId = 'status-filter-menu'

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#fbfdff] px-[clamp(22px,3vw,38px)] py-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative block">
            <span className="sr-only">{t('tasks.search')}</span>
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#526381]" />
            <input
              aria-label={t('tasks.search')}
              className="h-12 w-[min(280px,calc(100vw-52px))] rounded-lg border border-slate-300 bg-white pl-12 pr-4 text-sm font-bold text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] outline-none transition placeholder:text-[#71809a] focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={t('tasks.search')}
              type="search"
              value={searchQuery}
            />
          </label>
          <FilterButton icon={<FilterIcon />} label={t('tasks.filter.all')} />
          <div className="relative">
            <FilterButton
              active={statusFilter !== 'all'}
              ariaControls={statusFilterMenuId}
              ariaExpanded={isStatusMenuOpen}
              ariaHaspopup="menu"
              icon={<StatusIcon />}
              id={statusFilterButtonId}
              label={t('tasks.filter.status')}
              onClick={() => onStatusMenuOpenChange(!isStatusMenuOpen)}
            />
            {isStatusMenuOpen ? (
              <div
                aria-labelledby={statusFilterButtonId}
                className="absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-[0_18px_42px_rgba(30,52,88,0.18)]"
                id={statusFilterMenuId}
                role="menu"
              >
                {(['all', ...taskStatuses] as const).map((status) => (
                  <button
                    aria-checked={statusFilter === status}
                    className={`flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm font-black transition ${
                      statusFilter === status
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-[#263550] hover:bg-slate-100'
                    }`}
                    key={status}
                    onClick={() => onStatusFilterChange(status)}
                    role="menuitemradio"
                    type="button"
                  >
                    {status === 'all' ? t('tasks.filter.statusAll') : t(`tasks.status.${status}`)}
                    {statusFilter === status ? <CheckIcon /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <FilterButton icon={<AssigneeIcon />} label={t('tasks.filter.assignee')} />
          <FilterButton icon={<CalendarIcon />} label={t('tasks.filter.dueDate')} />
          <FilterButton icon={<FlagIcon />} label={t('tasks.filter.priority')} />
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <p className="text-sm font-black text-[#0d1833]">
            {t('tasks.sort.dueDate')}{' '}
            <span aria-hidden="true" className="text-xl leading-none">
              ↑
            </span>
          </p>
          <button
            className="inline-flex h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 text-sm font-black text-[#0d1833] shadow-[0_10px_24px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600"
            type="button"
          >
            <SettingsMiniIcon />
            {t('tasks.viewSettings')}
          </button>
        </div>
      </div>

      {activeTab === 'table' ? (
        <TaskTable
          selectedTaskIds={selectedTaskIds}
          onTaskSelectionChange={onTaskSelectionChange}
          t={t}
          taskErrorMessage={taskErrorMessage}
          tasks={tasks}
        />
      ) : (
        <section
          aria-live="polite"
          className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white px-7 py-12 text-center shadow-[0_22px_54px_rgba(30,52,88,0.06)]"
        >
          <h2 className="text-2xl font-black text-[#0d1833]">{t(viewLabelKeys[activeTab])}</h2>
          <p className="mt-3 text-sm font-bold text-[#526381]">
            {t('tasks.count').replace('{count}', String(tasks.length))}
          </p>
        </section>
      )}
    </div>
  )
}

function TaskTable({
  selectedTaskIds,
  onTaskSelectionChange,
  t,
  taskErrorMessage,
  tasks,
}: {
  selectedTaskIds: string[]
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  t: (key: MessageKey) => string
  taskErrorMessage?: string
  tasks: ProjectTask[]
}) {
  return (
    <section
      aria-label={t('tasks.table.aria')}
      className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_22px_54px_rgba(30,52,88,0.06)]"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-white text-left text-sm font-black text-[#0d1833]">
              <th className="px-7 py-4" scope="col">
                <span className="inline-flex items-center gap-2">
                  {t('tasks.column.name')}
                  <span aria-hidden="true" className="text-[#526381]">
                    ↕
                  </span>
                </span>
              </th>
              <th className="px-4 py-4" scope="col">
                {t('tasks.column.assignee')}
              </th>
              <th className="px-4 py-4" scope="col">
                {t('tasks.column.status')}
              </th>
              <th className="px-4 py-4" scope="col">
                {t('tasks.column.dueDate')}
              </th>
              <th className="px-4 py-4" scope="col">
                {t('tasks.column.priority')}
              </th>
              <th className="px-4 py-4 text-center text-xl text-[#526381]" scope="col">
                +
              </th>
            </tr>
          </thead>
          <tbody>
            {taskErrorMessage ? (
              <tr>
                <td
                  className="px-7 py-8 text-sm font-bold text-red-600"
                  colSpan={6}
                  data-testid="tasks-error"
                >
                  {taskErrorMessage === t('tasks.error.loading')
                    ? taskErrorMessage
                    : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
                </td>
              </tr>
            ) : tasks.length > 0 ? (
              tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  onTaskSelectionChange={onTaskSelectionChange}
                  selected={selectedTaskIds.includes(task.id)}
                  t={t}
                  task={task}
                />
              ))
            ) : (
              <tr>
                <td
                  className="px-7 py-8 text-sm font-bold text-[#526381]"
                  colSpan={6}
                  data-testid="tasks-empty"
                >
                  {t('tasks.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-center border-t border-slate-200 px-7 py-4 text-sm font-bold">
        <button
          className="inline-flex items-center gap-2 text-blue-600 transition hover:text-blue-500"
          type="button"
        >
          <PlusIcon className="h-5 w-5" />
          {t('tasks.addTask')}
        </button>
        <span className="text-[#526381]" data-testid="tasks-count">
          {t('tasks.count').replace('{count}', String(tasks.length))}
        </span>
      </div>
    </section>
  )
}

function SummaryCard({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const totalCount = tasks.length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const inProgressCount = tasks.filter((task) => task.status === 'in-progress').length
  const completionRate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  const projectMetrics: ProjectMetric[] = [
    {
      labelKey: 'tasks.metric.inProgress',
      value: String(inProgressCount),
      progressPercent: totalCount > 0 ? Math.round((inProgressCount / totalCount) * 100) : 0,
      accentClassName: 'bg-blue-600',
    },
    {
      labelKey: 'tasks.metric.done',
      value: String(doneCount),
      progressPercent: completionRate,
      accentClassName: 'bg-emerald-500',
    },
  ]

  return (
    <section
      aria-label={t('tasks.summary.aria')}
      className="mb-4 flex min-w-[500px] items-center rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-[0_18px_42px_rgba(30,52,88,0.08)] max-[1280px]:hidden"
    >
      {projectMetrics.map((metric) => (
        <div className="min-w-[120px] border-r border-slate-200 px-2" key={metric.labelKey}>
          <p className="text-sm font-black text-[#263550]">{t(metric.labelKey)}</p>
          <p className="mt-2 text-3xl font-black leading-none text-blue-600">{metric.value}</p>
          <div className="mt-3 h-1 rounded-full bg-slate-200">
            <div
              className={`h-1 rounded-full ${metric.accentClassName}`}
              style={{ width: `${metric.progressPercent}%` }}
            />
          </div>
        </div>
      ))}
      <div className="px-5">
        <p className="text-sm font-black text-[#263550]">{t('tasks.metric.completionRate')}</p>
        <p className="mt-2 text-3xl font-black leading-none text-[#0d1833]">{completionRate}%</p>
      </div>
      <div className="relative h-[72px] w-[72px]">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(#2563eb 0 ${completionRate}%, #dce2ea ${completionRate}% 100%)`,
          }}
        />
        <div className="absolute inset-[11px] rounded-full bg-white" />
      </div>
    </section>
  )
}

function FilterButton({
  active = false,
  ariaControls,
  ariaExpanded,
  ariaHaspopup,
  icon,
  id,
  label,
  onClick,
}: {
  active?: boolean
  ariaControls?: string
  ariaExpanded?: boolean
  ariaHaspopup?: 'menu'
  icon: ReactNode
  id?: string
  label: string
  onClick?: () => void
}) {
  return (
    <button
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      aria-label={label}
      className={`inline-flex h-12 min-w-[128px] items-center justify-between gap-3 rounded-lg border bg-white px-4 text-sm font-black shadow-[0_10px_24px_rgba(30,52,88,0.04)] transition ${
        active
          ? 'border-blue-500 text-blue-700'
          : 'border-slate-200 text-[#0d1833] hover:border-blue-500 hover:text-blue-600'
      }`}
      id={id}
      onClick={onClick}
      type="button"
    >
      <span className="inline-flex items-center gap-3">
        {icon}
        {label}
      </span>
      <ChevronIcon className="h-4 w-4" />
    </button>
  )
}

function TaskRow({
  selected,
  onTaskSelectionChange,
  task,
  t,
}: {
  selected: boolean
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  task: ProjectTask
  t: (key: MessageKey) => string
}) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'bg-blue-100 text-blue-700',
    review: 'bg-orange-100 text-orange-600',
    todo: 'bg-slate-100 text-[#263550]',
    done: 'bg-emerald-100 text-emerald-700',
  }
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'bg-red-100 text-red-600',
    medium: 'bg-orange-100 text-orange-600',
    low: 'bg-emerald-100 text-emerald-700',
  }
  const taskTitle = t(task.titleKey)
  const isOverdue = isTaskOverdue(task)

  return (
    <tr
      className="border-b border-slate-200 text-[15px] font-bold text-[#0d1833] last:border-b-0 hover:bg-blue-50/40"
      data-selected={selected ? 'true' : 'false'}
      data-testid={`task-row-${task.id}`}
    >
      <td className="px-7 py-3.5">
        <div className="flex min-w-0 items-center gap-4">
          <input
            aria-label={taskTitle}
            checked={selected}
            className="h-5 w-5 rounded border-slate-300 text-blue-600"
            onChange={(event) => onTaskSelectionChange(task.id, event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0 truncate">{taskTitle}</span>
          {selected ? (
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3.5">{t(task.assigneeKey)}</td>
      <td className="px-4 py-3.5">
        <span className={`inline-flex rounded-lg px-4 py-2 text-sm font-black ${statusClasses[task.status]}`}>
          {t(`tasks.status.${task.status}`)}
        </span>
      </td>
      <td
        className={`px-4 py-3.5 ${
          task.status === 'done' ? 'text-[#405174] line-through' : isOverdue ? 'text-red-600' : ''
        }`}
      >
        {task.dueDate}
      </td>
      <td className="px-4 py-3.5">
        <span
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-black ${priorityClasses[task.priority]}`}
        >
          <FlagIcon className="h-4 w-4" />
          {t(`tasks.priority.${task.priority}`)}
        </span>
      </td>
      <td className="px-4 py-3.5" />
    </tr>
  )
}

function isTaskOverdue(task: ProjectTask) {
  const dueDate = parseTaskDueDate(task.dueDate)

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return dueDate < today
}

function parseTaskDueDate(value: string) {
  const [year, month, day] = value.split('/').map(Number)

  if (!year || !month || !day) {
    return null
  }

  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return Number.isNaN(date.getTime()) ? null : date
}

function IconButton({
  children,
  label,
  rounded = false,
}: {
  children: ReactNode
  label: string
  rounded?: boolean
}) {
  return (
    <button
      aria-label={label}
      className={`grid h-12 w-12 place-items-center text-[#334463] transition hover:bg-slate-100 hover:text-blue-600 ${
        rounded ? 'rounded-full' : 'rounded-lg'
      }`}
      type="button"
    >
      {children}
    </button>
  )
}

function ProjectGlyph() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded-md border border-blue-500 text-[11px] font-black text-blue-600">
      P
    </span>
  )
}

function TabIcon({ tab }: { tab: TaskTab }) {
  const icons: Record<TaskTab, string> = {
    table: 'T',
    board: 'B',
    gantt: 'G',
    calendar: 'C',
    file: 'F',
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-6 w-6 place-items-center rounded-md bg-blue-50 text-xs font-black text-blue-700"
    >
      {icons[tab]}
    </span>
  )
}

function IconShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className || 'h-5 w-5'}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  )
}

function SearchIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconShell>
  )
}

function StarIcon() {
  return (
    <IconShell>
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z" />
    </IconShell>
  )
}

function MoreIcon() {
  return (
    <IconShell>
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </IconShell>
  )
}

function UsersMiniIcon() {
  return (
    <IconShell>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </IconShell>
  )
}

function PlusIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <path d="M12 5v14M5 12h14" />
    </IconShell>
  )
}

function BellOutlineIcon() {
  return (
    <IconShell>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </IconShell>
  )
}

function FilterIcon() {
  return (
    <IconShell>
      <path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" />
    </IconShell>
  )
}

function StatusIcon() {
  return (
    <IconShell>
      <path d="M6 14a6 6 0 1 0 12 0" />
      <path d="M12 2v6" />
      <path d="M8 6h8" />
    </IconShell>
  )
}

function AssigneeIcon() {
  return (
    <IconShell>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </IconShell>
  )
}

function CalendarIcon() {
  return (
    <IconShell>
      <path d="M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" />
    </IconShell>
  )
}

function FlagIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <path d="M5 21V5" />
      <path d="M5 5h12l-1.5 4L17 13H5" />
    </IconShell>
  )
}

function SettingsMiniIcon() {
  return (
    <IconShell>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-.4-1 1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1-.4 1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 .4 1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1 .4h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1 .4 1.7 1.7 0 0 0-.6 1Z" />
    </IconShell>
  )
}

function CheckIcon() {
  return (
    <IconShell className="h-4 w-4">
      <path d="m5 12 4 4L19 6" />
    </IconShell>
  )
}
