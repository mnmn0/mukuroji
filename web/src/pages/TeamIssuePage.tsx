import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import useSWR from 'swr'
import { getCurrentUser } from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
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
  createTeamIssue,
  createTeamIssueComment,
  getTeamIssueDetail,
  getTeamIssues,
  type CreateTeamIssueInput,
  type TeamIssue,
  type TeamIssueActivity,
  type TeamIssueComment,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../issues/api'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  getProjectDirectory,
  getProjectMembers,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  type ProjectDirectoryTeam,
  type ProjectMember,
} from '../projects/api'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import type { TaskPriority, TaskStatus } from '../tasks/api'

const issueStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]
const issuePriorities = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]
const emptyTeams: ProjectDirectoryTeam[] = []
const emptyIssues: TeamIssue[] = []
const emptyMembers: ProjectMember[] = []
const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * TeamIssueScreen で切り替える Issue 表示モードです。
 */
type IssueViewMode = 'table' | 'board'

/**
 * チーム所有 Issue 画面を描画する props です。
 */
type TeamIssueScreenProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 表示中のチーム ID です。
   */
  teamId: string
  /**
   * サイドバーとプロジェクト selector に表示するチーム一覧です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示中のチーム名です。
   */
  teamName?: string
  /**
   * Issue 一覧です。
   */
  issues?: TeamIssue[]
  /**
   * Issue コメント一覧です。
   */
  comments?: TeamIssueComment[]
  /**
   * Issue 活動履歴一覧です。
   */
  activity?: TeamIssueActivity[]
  /**
   * タスク担当者として選択できる project member 一覧です。
   */
  assigneeOptions?: ProjectMember[]
  /**
   * ログインユーザーのアバター頭文字です。
   */
  userInitial: string
  /**
   * 認証または API 確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
  /**
   * Issue 一覧の取得失敗時に表示するエラーメッセージです。
   */
  issueErrorMessage?: string
  /**
   * Issue 詳細の取得失敗時に表示するエラーメッセージです。
   */
  detailErrorMessage?: string
  /**
   * 現在選択中の Issue ID です。
   */
  selectedIssueId?: string
  /**
   * Issue を選択したときの callback です。
   */
  onSelectIssue?: (issueId: string) => void
  /**
   * Issue 作成時の callback です。
   */
  onCreateIssue?: (input: CreateTeamIssueInput) => Promise<void>
  /**
   * Issue 更新時の callback です。
   */
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /**
   * Issue コメント作成時の callback です。
   */
  onCreateComment?: (issueId: string, body: string) => Promise<void>
  /**
   * サイドバーからプロジェクトを選択したときの callback です。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
  /**
   * サイドバーの固定ナビを選択したときの callback です。
   */
  onSelectNav?: (navId: SidebarNavId) => void
  /**
   * サイドバーのチーム固定ビューを選択したときの callback です。
   */
  onSelectTeamView?: (teamId: string, viewId: SidebarTeamViewId) => void
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
}

/**
 * Cognito 認証後に表示するチーム所有 Issue ページです。
 */
export function TeamIssuePage() {
  const navigate = useNavigate()
  const params = useParams()
  const teamId = params.teamId ?? 'core-team'
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [selectedIssueId, setSelectedIssueId] = useState<string | undefined>()
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(currentUserKey, ([, token]) => getCurrentUser(token), apiSWRConfig)
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const {
    data: teams = emptyTeams,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useSWR(
    projectDirectoryKey,
    ([, token, currentLocale]) => getProjectDirectory(token, currentLocale),
    apiSWRConfig,
  )
  const activeTeam = teams.find((team) => team.id === teamId)
  const issueKey = accessToken && user && !currentUserError
    ? (['team-issues', accessToken, teamId] as const)
    : null
  const {
    data: issues = emptyIssues,
    error: issueError,
    isLoading: isIssuesLoading,
    mutate: mutateIssues,
  } = useSWR(issueKey, ([, token, currentTeamId]) => getTeamIssues(currentTeamId, token), apiSWRConfig)
  const resolvedSelectedIssueId = selectedIssueId && issues.some((issue) => issue.id === selectedIssueId)
    ? selectedIssueId
    : issues[0]?.id
  const detailKey = accessToken && resolvedSelectedIssueId
    ? (['team-issue-detail', accessToken, teamId, resolvedSelectedIssueId] as const)
    : null
  const {
    data: issueDetail,
    error: detailError,
    mutate: mutateIssueDetail,
  } = useSWR(
    detailKey,
    ([, token, currentTeamId, issueId]) => getTeamIssueDetail(currentTeamId, issueId, token),
    apiSWRConfig,
  )
  const memberKey = accessToken && activeTeam
    ? (['team-issue-members', accessToken, activeTeam.projects.map((project) => project.id).join('\u0000')] as const)
    : null
  const { data: assigneeOptions = emptyMembers } = useSWR(
    memberKey,
    ([, token]) => loadTeamProjectMembers(token, activeTeam?.projects.map((project) => project.id) ?? []),
    apiSWRConfig,
  )
  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(user && isIssuesLoading)
  const issueErrorMessage = issueError
    ? t('issues.error.loading')
    : undefined
  const detailErrorMessage = detailError
    ? t('issues.error.detail')
    : undefined

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
    if (currentUserError) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [currentUserError, navigate])

  const handleCreateIssue = async (input: CreateTeamIssueInput) => {
    if (!accessToken) {
      return
    }

    const issue = await createTeamIssue(teamId, accessToken, input)
    setSelectedIssueId(issue.id)
    await mutateIssues()
  }

  const handleUpdateIssue = async (issueId: string, input: UpdateTeamIssueInput) => {
    if (!accessToken) {
      return
    }

    await updateTeamIssue(teamId, issueId, accessToken, input)
    await mutateIssues()
    await mutateIssueDetail()
  }

  const handleCreateComment = async (issueId: string, body: string) => {
    if (!accessToken) {
      return
    }

    await createTeamIssueComment(teamId, issueId, accessToken, body)
    await mutateIssueDetail()
  }

  const handleCreateTeam = async (input: CreateProjectDirectoryTeamInput) => {
    if (!accessToken) {
      return
    }

    await createProjectDirectoryTeam(accessToken, input)
    await mutateProjectDirectory()
  }

  const handleCreateProject = async (
    nextTeamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await createProjectDirectoryProject(accessToken, nextTeamId, input)
    await mutateProjectDirectory()
  }

  const handleArchiveTeam = async (nextTeamId: string) => {
    if (!accessToken) {
      return
    }

    await archiveProjectDirectoryTeam(accessToken, nextTeamId)
    await mutateProjectDirectory()

    if (nextTeamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }

  const handleArchiveProject = async (nextTeamId: string, projectId: string) => {
    if (!accessToken) {
      return
    }

    await archiveProjectDirectoryProject(accessToken, nextTeamId, projectId)
    await mutateProjectDirectory()
  }

  return (
    <TeamIssueScreen
      activity={issueDetail?.activity}
      assigneeOptions={assigneeOptions}
      comments={issueDetail?.comments}
      detailErrorMessage={detailErrorMessage}
      issueErrorMessage={issueErrorMessage}
      issues={issues}
      isLoading={isLoading}
      locale={locale}
      onArchiveProject={handleArchiveProject}
      onArchiveTeam={handleArchiveTeam}
      onCreateComment={handleCreateComment}
      onCreateIssue={handleCreateIssue}
      onCreateProject={handleCreateProject}
      onCreateTeam={handleCreateTeam}
      onSelectIssue={setSelectedIssueId}
      onSelectNav={(navId) => navigate(workspaceNavPaths[navId])}
      onSelectProject={(projectId, nextTeamId) => navigate(createProjectIssuesPath(projectId, nextTeamId))}
      onSelectTeamView={(nextTeamId, viewId) => navigate(createTeamViewPath(nextTeamId, viewId))}
      onUpdateIssue={handleUpdateIssue}
      selectedIssueId={resolvedSelectedIssueId}
      teamId={teamId}
      teamName={activeTeam?.name}
      teams={teams}
      userInitial={userInitial}
    />
  )
}

/**
 * チーム所有 Issue の管理 UI を描画する Storybook 兼用 screen です。
 */
export function TeamIssueScreen({
  activity = [],
  assigneeOptions = [],
  comments = [],
  detailErrorMessage,
  issueErrorMessage,
  issues = [],
  isLoading = false,
  locale,
  onArchiveProject,
  onArchiveTeam,
  onCreateComment,
  onCreateIssue,
  onCreateProject,
  onCreateTeam,
  onSelectIssue,
  onSelectNav,
  onSelectProject,
  onSelectTeamView,
  onUpdateIssue,
  selectedIssueId,
  teamId,
  teamName,
  teams,
  userInitial,
}: TeamIssueScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [viewMode, setViewMode] = useState<IssueViewMode>('table')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createErrorMessage, setCreateErrorMessage] = useState<string | undefined>()
  const [detailErrorMessageLocal, setDetailErrorMessageLocal] = useState<string | undefined>()
  const activeTeam = teams.find((team) => team.id === teamId)
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId)
  const visibleIssues = useMemo(
    () =>
      issues.filter((issue) => {
        const matchesStatus = statusFilter === 'all' || issue.status === statusFilter
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return [
          resolveIssueTitle(issue, t),
          resolveIssueAssignee(issue),
          resolveAssignedProjectName(issue, activeTeam, t),
          t(`tasks.status.${issue.status}`),
          t(`tasks.priority.${issue.priority}`),
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      }),
    [activeTeam, issues, searchQuery, statusFilter, t],
  )

  return (
    <main className="flex h-svh min-h-0 overflow-hidden bg-[#f6f9fd] text-[#0d1833]">
      <Sidebar
        activeTeamId={teamId}
        activeTeamViewId="issues"
        className="max-[980px]:hidden"
        inboxCount={issues.filter((issue) => issue.status === 'review' || issue.priority === 'high').length}
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
          activeTeamId={teamId}
          activeTeamViewId="issues"
          inboxCount={issues.filter((issue) => issue.status === 'review' || issue.priority === 'high').length}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            onSelectNav?.(navId)
          }}
          onSelectProject={(projectId, nextTeamId) => {
            setIsMobileSidebarOpen(false)
            onSelectProject?.(projectId, nextTeamId)
          }}
          onSelectTeamView={(nextTeamId, viewId) => {
            setIsMobileSidebarOpen(false)
            onSelectTeamView?.(nextTeamId, viewId)
          }}
          teams={teams}
        />
      </MobileSidebarDrawer>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#fbfdff]">
        <header className="flex-none border-b border-slate-200 bg-white px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={() => setIsMobileSidebarOpen(true)}
              />
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-normal text-blue-600">
                  {t('issues.eyebrow')}
                </p>
                <h1
                  className="mt-2 truncate text-page-title font-black text-[#0d1833]"
                  data-testid="team-issues-heading"
                >
                  {teamName ?? t('issues.title')}
                </h1>
                <p className="mt-2 max-w-[760px] text-sm font-bold leading-6 text-[#526381]">
                  {t('issues.description')}
                </p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              <button
                aria-expanded={isCreateOpen}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-black text-white shadow-[0_12px_24px_rgba(37,99,235,0.22)] transition hover:bg-blue-500"
                onClick={() => setIsCreateOpen(!isCreateOpen)}
                type="button"
              >
                + {t('issues.action.new')}
              </button>
              <div className="grid h-10 w-10 place-items-center rounded-full bg-blue-100 text-sm font-black text-blue-700">
                {userInitial}
              </div>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-bold text-[#526381]">
            {t('issues.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(340px,430px)] gap-0 max-[1080px]:grid-cols-1">
              <section className="min-w-0 px-[clamp(20px,3vw,34px)] py-5">
                {isCreateOpen ? (
                  <CreateIssuePanel
                    assigneeOptions={assigneeOptions}
                    errorMessage={createErrorMessage}
                    onCancel={() => {
                      setCreateErrorMessage(undefined)
                      setIsCreateOpen(false)
                    }}
                    onSubmit={async (input) => {
                      if (!onCreateIssue) {
                        return
                      }

                      setCreateErrorMessage(undefined)

                      try {
                        await onCreateIssue(input)
                        setIsCreateOpen(false)
                      } catch (error) {
                        setCreateErrorMessage(error instanceof Error ? error.message : t('issues.error.create'))
                      }
                    }}
                    projects={activeTeam?.projects ?? []}
                    t={t}
                  />
                ) : null}
                <IssueToolbar
                  onSearchQueryChange={setSearchQuery}
                  onStatusFilterChange={setStatusFilter}
                  onViewModeChange={setViewMode}
                  searchQuery={searchQuery}
                  statusFilter={statusFilter}
                  t={t}
                  viewMode={viewMode}
                />
                {issueErrorMessage ? (
                  <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
                    {issueErrorMessage}
                  </p>
                ) : null}
                {viewMode === 'table' ? (
                  <IssueTable
                    activeTeam={activeTeam}
                    issues={visibleIssues}
                    onSelectIssue={onSelectIssue}
                    selectedIssueId={selectedIssueId}
                    t={t}
                  />
                ) : (
                  <IssueBoard
                    activeTeam={activeTeam}
                    issues={visibleIssues}
                    onSelectIssue={onSelectIssue}
                    selectedIssueId={selectedIssueId}
                    t={t}
                  />
                )}
              </section>
              <IssueDetailPane
                activity={activity}
                assigneeOptions={assigneeOptions}
                comments={comments}
                detailErrorMessage={detailErrorMessage ?? detailErrorMessageLocal}
                issue={selectedIssue}
                onCreateComment={async (issueId, body) => {
                  if (!onCreateComment) {
                    return
                  }

                  setDetailErrorMessageLocal(undefined)

                  try {
                    await onCreateComment(issueId, body)
                  } catch (error) {
                    setDetailErrorMessageLocal(error instanceof Error ? error.message : t('issues.error.comment'))
                  }
                }}
                onUpdateIssue={async (issueId, input) => {
                  if (!onUpdateIssue) {
                    return
                  }

                  setDetailErrorMessageLocal(undefined)

                  try {
                    await onUpdateIssue(issueId, input)
                  } catch (error) {
                    setDetailErrorMessageLocal(error instanceof Error ? error.message : t('issues.error.update'))
                  }
                }}
                projects={activeTeam?.projects ?? []}
                t={t}
              />
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function IssueToolbar({
  onSearchQueryChange,
  onStatusFilterChange,
  onViewModeChange,
  searchQuery,
  statusFilter,
  t,
  viewMode,
}: {
  onSearchQueryChange: (query: string) => void
  onStatusFilterChange: (status: TaskStatus | 'all') => void
  onViewModeChange: (mode: IssueViewMode) => void
  searchQuery: string
  statusFilter: TaskStatus | 'all'
  t: (key: MessageKey) => string
  viewMode: IssueViewMode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1">
          <span className="sr-only">{t('issues.search')}</span>
          <input
            aria-label={t('issues.search')}
            className="h-10 w-[min(260px,calc(100vw-52px))] rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-bold outline-none transition placeholder:text-[#71809a] focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={t('issues.search')}
            type="search"
            value={searchQuery}
          />
        </label>
        <select
          aria-label={t('issues.filter.status')}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-black text-[#0d1833] outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          onChange={(event) => onStatusFilterChange(resolveIssueStatusFilter(event.target.value))}
          value={statusFilter}
        >
          <option value="all">{t('tasks.filter.statusAll')}</option>
          {issueStatuses.map((status) => (
            <option key={status} value={status}>
              {t(`tasks.status.${status}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-flex h-10 overflow-hidden rounded-lg border border-slate-300 bg-white">
        {(['table', 'board'] as const).map((mode) => (
          <button
            aria-pressed={viewMode === mode}
            className={`px-3.5 text-sm font-black transition ${
              viewMode === mode ? 'bg-blue-600 text-white' : 'text-[#263550] hover:bg-blue-50'
            }`}
            key={mode}
            onClick={() => onViewModeChange(mode)}
            type="button"
          >
            {t(`issues.view.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  )
}

function CreateIssuePanel({
  assigneeOptions,
  errorMessage,
  onCancel,
  onSubmit,
  projects,
  t,
}: {
  assigneeOptions: ProjectMember[]
  errorMessage?: string
  onCancel: () => void
  onSubmit: (input: CreateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
}) {
  const today = formatLocalDateInputValue()

  return (
    <section className="mb-5 min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.06)]">
      <form
        className="grid min-w-0 gap-4"
        data-testid="create-issue-form"
        onSubmit={(event) => {
          event.preventDefault()
          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const description = String(formData.get('description') ?? '').trim()
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? today).replaceAll('-', '/')

          void onSubmit({
            title,
            description,
            assignedProjectId: assignedProjectId || undefined,
            assigneeUserId,
            dueDate,
            priority: resolveIssuePriority(formData.get('priority')),
            status: resolveIssueStatus(formData.get('status')),
          })
        }}
      >
        <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('issues.create.title')}
            <input
              className="h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              name="title"
              placeholder={t('issues.create.titlePlaceholder')}
              required
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('issues.create.project')}
            <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" name="assignedProjectId">
              <option value="">{t('issues.project.unassigned')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('issues.create.assignee')}
            <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" name="assigneeUserId" required>
              <option disabled hidden value="">
                {t('tasks.create.assigneeSelectPlaceholder')}
              </option>
              {assigneeOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {formatProjectMemberOption(member)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('tasks.column.dueDate')}
            <input className="h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" defaultValue={today} name="dueDate" required type="date" />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('tasks.column.status')}
            <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" defaultValue="todo" name="status">
              {issueStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`tasks.status.${status}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('tasks.column.priority')}
            <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" defaultValue="medium" name="priority">
              {issuePriorities.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`tasks.priority.${priority}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
          {t('issues.create.description')}
          <textarea
            className="min-h-20 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
            name="description"
            placeholder={t('issues.create.descriptionPlaceholder')}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button className="h-11 rounded-lg bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500" type="submit">
            {t('issues.create.submit')}
          </button>
          <button className="h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-black text-[#263550] transition hover:border-blue-500 hover:text-blue-600" onClick={onCancel} type="button">
            {t('tasks.create.cancel')}
          </button>
          {errorMessage ? <p className="text-sm font-bold text-red-600">{errorMessage}</p> : null}
        </div>
      </form>
    </section>
  )
}

function IssueTable({
  activeTeam,
  issues,
  onSelectIssue,
  selectedIssueId,
  t,
}: {
  activeTeam?: ProjectDirectoryTeam
  issues: TeamIssue[]
  onSelectIssue?: (issueId: string) => void
  selectedIssueId?: string
  t: (key: MessageKey) => string
}) {
  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_22px_54px_rgba(30,52,88,0.06)]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-left text-sm font-black text-[#0d1833]">
              <th className="px-5 py-4" scope="col">{t('issues.column.title')}</th>
              <th className="px-4 py-4" scope="col">{t('issues.column.project')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.assignee')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.status')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.dueDate')}</th>
              <th className="px-4 py-4" scope="col">{t('tasks.column.priority')}</th>
            </tr>
          </thead>
          <tbody>
            {issues.length > 0 ? (
              issues.map((issue) => (
                <tr
                  aria-selected={selectedIssueId === issue.id}
                  className={`cursor-pointer border-b border-slate-100 transition last:border-b-0 ${
                    selectedIssueId === issue.id ? 'bg-blue-50' : 'hover:bg-[#f8fbff]'
                  }`}
                  data-testid={`issue-row-${issue.id}`}
                  key={issue.id}
                  onClick={() => onSelectIssue?.(issue.id)}
                >
                  <td className="px-5 py-4 text-sm font-black text-[#0d1833]">{resolveIssueTitle(issue, t)}</td>
                  <td className="px-4 py-4 text-sm font-bold text-[#526381]">{resolveAssignedProjectName(issue, activeTeam, t)}</td>
                  <td className="px-4 py-4 text-sm font-bold text-[#526381]">{resolveIssueAssignee(issue)}</td>
                  <td className="px-4 py-4"><IssueStatusBadge status={issue.status} t={t} /></td>
                  <td className="px-4 py-4 text-sm font-bold text-[#526381]">{issue.dueDate}</td>
                  <td className="px-4 py-4"><IssuePriorityBadge priority={issue.priority} t={t} /></td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-sm font-bold text-[#526381]" colSpan={6} data-testid="team-issues-empty">
                  {t('issues.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 px-5 py-4 text-sm font-bold text-[#526381]" data-testid="team-issues-count">
        {t('issues.count').replace('{count}', String(issues.length))}
      </div>
    </section>
  )
}

function IssueBoard({
  activeTeam,
  issues,
  onSelectIssue,
  selectedIssueId,
  t,
}: {
  activeTeam?: ProjectDirectoryTeam
  issues: TeamIssue[]
  onSelectIssue?: (issueId: string) => void
  selectedIssueId?: string
  t: (key: MessageKey) => string
}) {
  return (
    <section className="mt-5 grid grid-cols-1 gap-4 min-[1280px]:grid-cols-2 min-[1900px]:grid-cols-4">
      {issueStatuses.map((status) => {
        const columnIssues = issues.filter((issue) => issue.status === status)

        return (
          <div className="min-h-[420px] rounded-lg border border-slate-200 bg-white shadow-[0_22px_54px_rgba(30,52,88,0.06)]" key={status}>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <IssueStatusBadge status={status} t={t} />
              <span className="text-sm font-black text-[#526381]">{columnIssues.length}</span>
            </div>
            <div className="grid gap-3 p-3">
              {columnIssues.length > 0 ? (
                columnIssues.map((issue) => (
                  <button
                    className={`rounded-lg border p-4 text-left transition ${
                      selectedIssueId === issue.id
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-slate-200 bg-[#fbfdff] hover:border-blue-300 hover:bg-blue-50/30'
                    }`}
                    key={issue.id}
                    onClick={() => onSelectIssue?.(issue.id)}
                    type="button"
                  >
                    <p className="text-sm font-black leading-6 text-[#0d1833]">{resolveIssueTitle(issue, t)}</p>
                    <p className="mt-2 text-xs font-bold text-[#526381]">{resolveAssignedProjectName(issue, activeTeam, t)}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <IssuePriorityBadge priority={issue.priority} t={t} />
                      <span className="text-xs font-black text-[#526381]">{issue.dueDate}</span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]">
                  {t('tasks.board.empty')}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function IssueDetailPane({
  activity,
  assigneeOptions,
  comments,
  detailErrorMessage,
  issue,
  onCreateComment,
  onUpdateIssue,
  projects,
  t,
}: {
  activity: TeamIssueActivity[]
  assigneeOptions: ProjectMember[]
  comments: TeamIssueComment[]
  detailErrorMessage?: string
  issue?: TeamIssue
  onCreateComment?: (issueId: string, body: string) => Promise<void>
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
}) {
  if (!issue) {
    return (
      <aside className="min-h-0 min-w-0 border-l border-slate-200 bg-white px-6 py-7 max-[1080px]:border-l-0 max-[1080px]:border-t">
        <p className="text-sm font-bold text-[#526381]">{t('issues.detail.empty')}</p>
      </aside>
    )
  }

  const isLegacyIssue = issue.source === 'legacy'
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === issue.assigneeUserId)

  return (
    <aside className="min-h-0 min-w-0 border-l border-slate-200 bg-white px-6 py-7 max-[1080px]:border-l-0 max-[1080px]:border-t">
      <form
        className="grid min-w-0 gap-4"
        key={issue.id}
        onSubmit={(event) => {
          event.preventDefault()

          if (isLegacyIssue) {
            return
          }

          const formData = new FormData(event.currentTarget)
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: assignedProjectId || null,
            description: String(formData.get('description') ?? '').trim(),
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
            priority: resolveIssuePriority(formData.get('priority')),
            status: resolveIssueStatus(formData.get('status')),
            title: String(formData.get('title') ?? '').trim(),
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(issue.id, nextIssueInput)
        }}
      >
        <fieldset className="contents" disabled={isLegacyIssue}>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('issues.column.title')}
            <input className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-xl font-black outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={resolveIssueTitle(issue, t)} name="title" required />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
            {t('issues.create.description')}
            <textarea className="min-h-28 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.description} name="description" />
          </label>
          <div className="grid grid-cols-1 gap-3">
            <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
              {t('issues.create.project')}
              <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.assignedProjectId ?? ''} name="assignedProjectId">
                <option value="">{t('issues.project.unassigned')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
              {t('issues.create.assignee')}
              <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.assigneeUserId} name="assigneeUserId">
                {!hasSelectedAssigneeOption ? (
                  <option value={issue.assigneeUserId}>{resolveIssueAssignee(issue)}</option>
                ) : null}
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
              {t('tasks.column.status')}
              <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.status} name="status">
                {issueStatuses.map((status) => (
                  <option key={status} value={status}>{t(`tasks.status.${status}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
              {t('tasks.column.priority')}
              <select className="h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.priority} name="priority">
                {issuePriorities.map((priority) => (
                  <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
              {t('tasks.column.dueDate')}
              <input className="h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" defaultValue={issue.dueDate.replaceAll('/', '-')} name="dueDate" type="date" />
            </label>
          </div>
        </fieldset>
        <button className="h-11 rounded-lg bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:bg-slate-300" disabled={isLegacyIssue} type="submit">
          {t('issues.detail.save')}
        </button>
        {isLegacyIssue ? <p className="text-sm font-bold text-[#526381]">{t('issues.detail.readOnlyLegacy')}</p> : null}
        {detailErrorMessage ? <p className="text-sm font-bold text-red-600">{detailErrorMessage}</p> : null}
      </form>
      <form
        className="mt-7 grid gap-3 border-t border-slate-200 pt-6"
        onSubmit={(event) => {
          event.preventDefault()

          if (isLegacyIssue) {
            return
          }

          const form = event.currentTarget
          const formData = new FormData(form)
          const body = String(formData.get('body') ?? '').trim()

          if (!body) {
            form.reportValidity()
            return
          }

          void onCreateComment?.(issue.id, body).then(() => form.reset())
        }}
      >
        <label className="grid min-w-0 gap-2 text-sm font-black text-[#263550]">
          {t('issues.comment.title')}
          <textarea className="min-h-20 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:bg-slate-50 disabled:text-slate-500" disabled={isLegacyIssue} name="body" required />
        </label>
        <button className="h-10 justify-self-start rounded-lg border border-slate-300 bg-white px-4 text-sm font-black text-[#263550] transition hover:border-blue-500 hover:text-blue-600 disabled:border-slate-200 disabled:text-slate-400" disabled={isLegacyIssue} type="submit">
          {t('issues.comment.submit')}
        </button>
      </form>
      <section className="mt-7 border-t border-slate-200 pt-6">
        <h2 className="text-sm font-black uppercase tracking-normal text-[#69758a]">{t('issues.comment.title')}</h2>
        <div className="mt-3 grid gap-3">
          {comments.length > 0 ? (
            comments.map((comment) => (
              <article className="rounded-lg bg-[#f8fbff] p-3" key={comment.id}>
                <p className="text-xs font-black text-[#526381]">{comment.actorUserId}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm font-bold leading-6 text-[#263550]">{comment.body}</p>
              </article>
            ))
          ) : (
            <p className="text-sm font-bold text-[#526381]">{t('issues.comment.empty')}</p>
          )}
        </div>
      </section>
      <section className="mt-7 border-t border-slate-200 pt-6">
        <h2 className="text-sm font-black uppercase tracking-normal text-[#69758a]">{t('issues.activity.title')}</h2>
        <div className="mt-3 grid gap-2">
          {activity.map((item) => (
            <p className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-[#526381]" key={item.id}>
              {item.summary}
            </p>
          ))}
        </div>
      </section>
    </aside>
  )
}

async function loadTeamProjectMembers(accessToken: string, projectIds: string[]) {
  const responses = await Promise.allSettled(projectIds.map((projectId) => getProjectMembers(accessToken, projectId)))
  const membersById = new Map<string, ProjectMember>()

  for (const response of responses) {
    if (response.status !== 'fulfilled') {
      continue
    }

    for (const member of response.value) {
      membersById.set(member.id, member)
    }
  }

  return Array.from(membersById.values())
}

function formatLocalDateInputValue(date = new Date()) {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function resolveIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  return issue.title ?? (issue.titleKey ? t(issue.titleKey) : issue.id)
}

function resolveIssueAssignee(issue: TeamIssue) {
  return issue.assigneeName ?? issue.assigneeEmail ?? issue.assigneeUserId
}

function resolveAssignedProjectName(
  issue: TeamIssue,
  team: ProjectDirectoryTeam | undefined,
  t: (key: MessageKey) => string,
) {
  if (!issue.assignedProjectId) {
    return t('issues.project.unassigned')
  }

  return team?.projects.find((project) => project.id === issue.assignedProjectId)?.name ?? issue.assignedProjectId
}

function resolveIssueStatus(value: FormDataEntryValue | null): TaskStatus {
  return typeof value === 'string' && issueStatuses.includes(value as TaskStatus)
    ? value as TaskStatus
    : 'todo'
}

function resolveIssueStatusFilter(value: string): TaskStatus | 'all' {
  return value === 'all' || issueStatuses.includes(value as TaskStatus)
    ? value as TaskStatus | 'all'
    : 'all'
}

function resolveIssuePriority(value: FormDataEntryValue | null): TaskPriority {
  return typeof value === 'string' && issuePriorities.includes(value as TaskPriority)
    ? value as TaskPriority
    : 'medium'
}

function formatProjectMemberOption(member: ProjectMember) {
  return member.name ? `${member.name} (${member.email})` : member.email
}

function IssueStatusBadge({ status, t }: { status: TaskStatus; t: (key: MessageKey) => string }) {
  const classes: Record<TaskStatus, string> = {
    done: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    'in-progress': 'bg-blue-50 text-blue-700 ring-blue-200',
    review: 'bg-amber-50 text-amber-700 ring-amber-200',
    todo: 'bg-slate-100 text-slate-700 ring-slate-200',
  }

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${classes[status]}`}>
      {t(`tasks.status.${status}`)}
    </span>
  )
}

function IssuePriorityBadge({ priority, t }: { priority: TaskPriority; t: (key: MessageKey) => string }) {
  const classes: Record<TaskPriority, string> = {
    high: 'bg-red-50 text-red-700 ring-red-200',
    low: 'bg-slate-100 text-slate-700 ring-slate-200',
    medium: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  }

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${classes[priority]}`}>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}
