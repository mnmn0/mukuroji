import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronIcon } from '../components/icons'
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
  type Locale,
  type MessageKey,
} from '../i18n'
import type { TeamIssueDetail, UpdateTeamIssueInput } from '../issues/api'
import type { IssueCollaborationController } from '../issues/useIssueCollaboration'
import { ProjectPermissionsPanel } from '../projects/ProjectPermissionsPanel'
import type {
  CreateProjectDirectoryProjectInput,
  CreateProjectDirectoryTeamInput,
  ProjectDirectoryTeam,
  ProjectMember,
  ProjectUser,
  UpdateProjectMemberInput,
} from '../projects/api'
import { resolveProjectTaskStatus, type CreateProjectTaskInput, type ProjectTask } from './api'
import type { WorkspaceMember } from '../workspace/api'
import { useWorkspaceCommandMenu } from '../commands/WorkspaceCommandMenuContext'
import {
  AssigneeIcon,
  BellOutlineIcon,
  CalendarIcon,
  CheckIcon,
  FilterIcon,
  FlagIcon,
  IconButton,
  MoreIcon,
  PlusIcon,
  ProjectGlyph,
  SearchIcon,
  StarIcon,
  StatusIcon,
  TabIcon,
  UsersMiniIcon,
} from './TaskIcons'
import { CreateTaskPanel, TaskDetailPane } from './TaskPanels'
import {
  FilterButton,
  SummaryCard,
  TaskBoard,
  TaskCalendar,
  TaskFileList,
  TaskGantt,
  TaskTable,
} from './TaskViews'
import {
  createAssigneeFilterOptions,
  matchesTaskDueDateFilter,
  resolveDueDateFilterLabelKey,
  resolveTaskAssignee,
  resolveTaskAssigneeFilterValue,
  resolveTaskSortOrderLabelKey,
  resolveTaskTitle,
  sortTasksByDueDate,
} from './taskPresentation'
import { findTaskBySelection, findTeamForProject } from './taskSelection'
import {
  taskDueDateFilters,
  taskPriorities,
  taskSortOrders,
  taskStatuses,
  taskTabs,
  type AssigneeFilter,
  type DueDateFilter,
  type PriorityFilter,
  type StatusFilter,
  type TaskSortOrder,
  type TaskTab,
} from './taskViewTypes'

const emptyProjectMembers: ProjectMember[] = []
const emptyProjectUsers: ProjectUser[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []

const taskTabPanelId = 'task-tabpanel'

function createTaskTabId(tab: TaskTab) {
  return `task-tab-${tab}`
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
   * サイドバーに表示する通知の実未読件数です。
   */
  inboxCount?: number
  /**
   * タスク担当者として選択できる project member 一覧です。
   */
  assigneeOptions?: ProjectMember[]
  /**
   * タスク担当者候補を取得中かどうかです。
   */
  isAssigneeOptionsLoading?: boolean
  /**
   * タスク担当者候補の取得失敗時に表示するエラーメッセージです。
   */
  assigneeErrorMessage?: string
  /**
   * 権限管理で表示する project member 一覧です。
   */
  projectMembers?: ProjectMember[]
  /**
   * 権限管理で選択できる Cognito user 候補です。
   */
  projectUsers?: ProjectUser[]
  /**
   * 権限管理の Cognito user 候補を取得中かどうかです。
   */
  isProjectUsersLoading?: boolean
  /**
   * 権限管理の Cognito user 候補取得失敗時に表示するエラーです。
   */
  projectUsersErrorMessage?: string
  /**
   * 権限管理の Cognito user 一覧次 page token です。
   */
  projectUsersNextToken?: string
  /**
   * 権限管理の Cognito user 検索 query です。
   */
  projectUserQuery?: string
  /**
   * ログインユーザーが system admin かどうかです。
   */
  isSystemAdmin?: boolean
  /**
   * ログインユーザーが project member role を管理できるかどうかです。
   */
  canManageProjectMembers?: boolean
  /**
   * 権限管理 API の失敗時に表示するエラーです。
   */
  projectMembersErrorMessage?: string
  /**
   * タスク一覧の取得失敗時に表示するエラーメッセージです。
   */
  taskErrorMessage?: string
  /**
   * 初期選択するプロジェクトビューのタブです。
   */
  initialTab?: TaskTab
  /**
   * 初期表示時にタスク作成パネルを開くかどうかです。
   */
  defaultCreateTaskOpen?: boolean
  /**
   * 初期表示時に詳細ペインで選択するタスク ID です。
   */
  initialSelectedTaskId?: string
  /**
   * 選択中 Issue の詳細、コメント、活動履歴です。
   */
  selectedIssueDetail?: TeamIssueDetail
  /**
   * 選択中 Issue の comment thread、watcher、presence です。
   */
  collaboration?: IssueCollaborationController
  /**
   * mention 候補と actor 表示に使う Workspace member 一覧です。
   */
  workspaceMembers?: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentWorkspaceMemberKey?: string
  /**
   * notification deep link から focus する comment ID です。
   */
  focusedCommentId?: string
  /**
   * notification deep link の reply が属する root comment ID です。
   */
  focusedRootCommentId?: string
  /**
   * 選択中 Issue 詳細を取得中かどうかです。
   */
  isSelectedIssueDetailLoading?: boolean
  /**
   * 選択中 Issue 詳細の取得または更新に失敗したときのエラーメッセージです。
   */
  detailErrorMessage?: string
  /**
   * 詳細ペインで選択するタスクを変更したときの callback です。
   */
  onSelectedIssueChange?: (task: ProjectTask) => void
  /**
   * 詳細ペインで Issue を更新するときの callback です。
   */
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
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
   * 新規タスクを保存するときの callback です。
   */
  onCreateTask?: (input: CreateProjectTaskInput) => Promise<void>
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
   * Cognito user 一覧の次 page 読み込み callback です。
   */
  onLoadMoreProjectUsers?: () => Promise<void>
  /**
   * Cognito user 検索 query 変更 callback です。
   */
  onProjectUserQueryChange?: (query: string) => void
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
}

/**
 * サイドバー、プロジェクトヘッダー、タスクビューを含むタスク管理画面です。
 */
export function TaskScreen({
  locale,
  projectId,
  userInitial,
  teams,
  projectName,
  teamName,
  activeProjectTeamId,
  assigneeErrorMessage,
  assigneeOptions = [],
  canManageProjectMembers = false,
  collaboration,
  currentWorkspaceMemberKey,
  defaultCreateTaskOpen = false,
  detailErrorMessage,
  focusedCommentId,
  focusedRootCommentId,
  inboxCount = 0,
  initialSelectedTaskId,
  initialTab = 'table',
  isAssigneeOptionsLoading = false,
  isProjectUsersLoading = false,
  isSelectedIssueDetailLoading = false,
  isSystemAdmin = false,
  isLoading = false,
  projectMembers = emptyProjectMembers,
  projectMembersErrorMessage,
  projectUserQuery = '',
  projectUsers = emptyProjectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  selectedIssueDetail,
  tasks = [],
  taskErrorMessage,
  onLoadMoreProjectUsers,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onSelectedIssueChange,
  onSelectProject,
  onSelectNav,
  onSelectTeamView,
  onCreateProject,
  onCreateTeam,
  onArchiveProject,
  onArchiveTeam,
  onCreateTask,
  onUpdateIssue,
  onUpdateProjectMember,
  workspaceMembers = emptyWorkspaceMembers,
}: TaskScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const [activeTab, setActiveTab] = useState<TaskTab>(initialTab)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false)
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all')
  const [isAssigneeMenuOpen, setIsAssigneeMenuOpen] = useState(false)
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [isPriorityMenuOpen, setIsPriorityMenuOpen] = useState(false)
  const [dueDateFilter, setDueDateFilter] = useState<DueDateFilter>('all')
  const [isDueDateMenuOpen, setIsDueDateMenuOpen] = useState(false)
  const [sortOrder, setSortOrder] = useState<TaskSortOrder>('due-date-asc')
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [localSelectedDetailTaskId, setLocalSelectedDetailTaskId] = useState<string | undefined>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(defaultCreateTaskOpen)
  const [createTaskError, setCreateTaskError] = useState<string | undefined>()
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const commandMenu = useWorkspaceCommandMenu()
  const taskContentRef = useRef<HTMLDivElement>(null)
  const resolvedProjectName = projectName ?? projectId
  const resolvedActiveTeam = findTeamForProject(teams, projectId, activeProjectTeamId)
  const resolvedActiveTeamId = activeProjectTeamId ?? resolvedActiveTeam?.id
  const resolvedTeamName = teamName ?? resolvedActiveTeam?.name ?? ''
  const activeTeamProjects = resolvedActiveTeam?.projects ?? []
  const selectedDetailTaskId = localSelectedDetailTaskId ?? initialSelectedTaskId

  useEffect(() => {
    if (defaultCreateTaskOpen) {
      queueMicrotask(() => setIsCreateTaskOpen(true))
    }
  }, [defaultCreateTaskOpen])

  const visibleTasks = useMemo(
    () => {
      const filteredTasks = tasks.filter((task) => {
        const matchesStatus = statusFilter === 'all' || resolveProjectTaskStatus(task) === statusFilter
        const matchesAssignee = assigneeFilter === 'all' || resolveTaskAssigneeFilterValue(task, t) === assigneeFilter
        const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter
        const matchesDueDate = matchesTaskDueDateFilter(task, dueDateFilter)
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus || !matchesAssignee || !matchesPriority || !matchesDueDate) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return [
          resolveTaskTitle(task, t),
          resolveTaskAssignee(task, t),
          t(`tasks.status.${resolveProjectTaskStatus(task)}`),
          t(`tasks.priority.${task.priority}`),
          task.dueDate,
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      })

      return sortTasksByDueDate(filteredTasks, sortOrder)
    },
    [assigneeFilter, dueDateFilter, priorityFilter, searchQuery, sortOrder, statusFilter, t, tasks],
  )
  const selectedDetailTask =
    findTaskBySelection(tasks, selectedDetailTaskId, resolvedActiveTeamId) ??
    findTaskBySelection(tasks, initialSelectedTaskId, resolvedActiveTeamId) ??
    visibleTasks[0] ??
    tasks[0]

  useEffect(() => {
    if (isCreateTaskOpen) {
      taskContentRef.current?.scrollTo({ top: 0 })
    }
  }, [isCreateTaskOpen])

  const updateTaskSelection = (taskId: string, selected: boolean) => {
    setSelectedTaskIds((currentTaskIds) =>
      selected
        ? [...new Set([...currentTaskIds, taskId])]
        : currentTaskIds.filter((currentTaskId) => currentTaskId !== taskId),
    )
  }

  const handleSelectDetailTask = (task: ProjectTask) => {
    if (!onSelectedIssueChange) {
      setLocalSelectedDetailTaskId(task.id)
    }
    onSelectedIssueChange?.(task)
  }

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <Sidebar
        activeProjectId={projectId}
        activeProjectTeamId={resolvedActiveTeamId}
        className="max-[980px]:hidden"
        collapsed={sidebarCollapsed}
        inboxCount={inboxCount}
        labels={sidebarLabels}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onOpenSearch={commandMenu.open}
        onSelectNav={onSelectNav}
        onCollapsedChange={setSidebarCollapsed}
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
          activeProjectId={projectId}
          activeProjectTeamId={resolvedActiveTeamId}
          inboxCount={inboxCount}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          onOpenSearch={() => {
            setIsMobileSidebarOpen(false)
            commandMenu.open?.()
          }}
          onSelectNav={(navId) => {
            setIsMobileSidebarOpen(false)
            onSelectNav?.(navId)
          }}
          onSelectProject={(nextProjectId, teamId) => {
            setIsMobileSidebarOpen(false)
            onSelectProject?.(nextProjectId, teamId)
          }}
          onSelectTeamView={(teamId, viewId) => {
            setIsMobileSidebarOpen(false)
            onSelectTeamView?.(teamId, viewId)
          }}
          teams={teams}
        />
      </MobileSidebarDrawer>

      <section className="workbench-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <TaskHeader
          activeTab={activeTab}
          isCreateTaskOpen={isCreateTaskOpen}
          onCreateTaskOpenChange={onCreateTask ? setIsCreateTaskOpen : undefined}
          onMobileSidebarOpen={() => setIsMobileSidebarOpen(true)}
          onTabChange={setActiveTab}
          projectName={resolvedProjectName}
          t={t}
          tasks={tasks}
          teamName={resolvedTeamName}
          userInitial={userInitial}
        />

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-semibold text-[#5f6874]">
            {t('tasks.loading')}
          </div>
        ) : (
          <div
            className="workbench-main min-h-0 flex-1 overflow-auto overscroll-contain"
            data-testid="task-main-scroll"
            ref={taskContentRef}
          >
            {isCreateTaskOpen && onCreateTask ? (
              <CreateTaskPanel
                assigneeErrorMessage={assigneeErrorMessage}
                assigneeOptions={assigneeOptions}
                isAssigneeOptionsLoading={isAssigneeOptionsLoading}
                errorMessage={createTaskError}
                isSubmitting={isCreatingTask}
                onCancel={() => {
                  setCreateTaskError(undefined)
                  setIsCreateTaskOpen(false)
                }}
                onSubmit={async (input) => {
                  if (!onCreateTask) {
                    return
                  }

                  setCreateTaskError(undefined)
                  setIsCreatingTask(true)

                  try {
                    await onCreateTask(input)
                    setIsCreateTaskOpen(false)
                  } catch (error) {
                    setCreateTaskError(error instanceof Error ? error.message : t('tasks.create.error'))
                  } finally {
                    setIsCreatingTask(false)
                  }
                }}
                t={t}
              />
            ) : null}
            <div
              aria-labelledby={createTaskTabId(activeTab)}
              className={`grid min-h-full ${activeTab === 'permissions' || activeTab === 'file' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(360px,440px)] max-[1180px]:grid-cols-1'}`}
              id={taskTabPanelId}
              role="tabpanel"
            >
              <TaskWorkspace
                activeTab={activeTab}
                allTasks={tasks}
                assigneeFilter={assigneeFilter}
                canManageProjectMembers={canManageProjectMembers}
                dueDateFilter={dueDateFilter}
                isAssigneeMenuOpen={isAssigneeMenuOpen}
                isDueDateMenuOpen={isDueDateMenuOpen}
                isPriorityMenuOpen={isPriorityMenuOpen}
                isSortMenuOpen={isSortMenuOpen}
                isStatusMenuOpen={isStatusMenuOpen}
                isProjectMembersLoading={isAssigneeOptionsLoading}
                isProjectUsersLoading={isProjectUsersLoading}
                isSystemAdmin={isSystemAdmin}
                priorityFilter={priorityFilter}
                projectId={projectId}
                projectMembers={projectMembers}
                projectMembersErrorMessage={projectMembersErrorMessage}
                projectName={resolvedProjectName}
                projectUserQuery={projectUserQuery}
                projectUsers={projectUsers}
                projectUsersErrorMessage={projectUsersErrorMessage}
                projectUsersNextToken={projectUsersNextToken}
                selectedDetailTaskId={selectedDetailTask?.id}
                sortOrder={sortOrder}
                onAssigneeFilterChange={(nextAssigneeFilter) => {
                  setAssigneeFilter(nextAssigneeFilter)
                  setIsAssigneeMenuOpen(false)
                }}
                onAssigneeMenuOpenChange={setIsAssigneeMenuOpen}
                onDueDateFilterChange={(nextDueDateFilter) => {
                  setDueDateFilter(nextDueDateFilter)
                  setIsDueDateMenuOpen(false)
                }}
                onDueDateMenuOpenChange={setIsDueDateMenuOpen}
                onLoadMoreProjectUsers={onLoadMoreProjectUsers}
                onCreateTaskOpen={onCreateTask ? () => setIsCreateTaskOpen(true) : undefined}
                onPriorityFilterChange={(nextPriorityFilter) => {
                  setPriorityFilter(nextPriorityFilter)
                  setIsPriorityMenuOpen(false)
                }}
                onPriorityMenuOpenChange={setIsPriorityMenuOpen}
                onProjectUserQueryChange={onProjectUserQueryChange}
                onRemoveProjectMember={onRemoveProjectMember}
                onSearchQueryChange={setSearchQuery}
                onSelectTask={handleSelectDetailTask}
                onSortMenuOpenChange={setIsSortMenuOpen}
                onSortOrderChange={(nextSortOrder) => {
                  setSortOrder(nextSortOrder)
                  setIsSortMenuOpen(false)
                }}
                onStatusFilterChange={(nextStatusFilter) => {
                  setStatusFilter(nextStatusFilter)
                  setIsStatusMenuOpen(false)
                }}
                onStatusMenuOpenChange={setIsStatusMenuOpen}
                onTaskSelectionChange={updateTaskSelection}
                onUpdateProjectMember={onUpdateProjectMember}
                searchQuery={searchQuery}
                selectedTaskIds={selectedTaskIds}
                statusFilter={statusFilter}
                t={t}
                taskErrorMessage={taskErrorMessage}
                tasks={visibleTasks}
              />
              {activeTab === 'permissions' || activeTab === 'file' ? null : (
                <TaskDetailPane
                  assigneeOptions={assigneeOptions}
                  collaboration={collaboration}
                  currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                  detail={selectedIssueDetail}
                  errorMessage={detailErrorMessage}
                  focusedCommentId={focusedCommentId}
                  focusedRootCommentId={focusedRootCommentId}
                  isLoading={isSelectedIssueDetailLoading}
                  locale={locale}
                  projects={activeTeamProjects}
                  t={t}
                  task={selectedDetailTask}
                  onUpdateIssue={onUpdateIssue}
                  workspaceMembers={workspaceMembers}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function TaskHeader({
  activeTab,
  isCreateTaskOpen,
  onCreateTaskOpenChange,
  onMobileSidebarOpen,
  onTabChange,
  projectName,
  t,
  tasks,
  teamName,
  userInitial,
}: {
  activeTab: TaskTab
  isCreateTaskOpen: boolean
  onCreateTaskOpenChange?: (isOpen: boolean) => void
  onMobileSidebarOpen: () => void
  onTabChange: (tab: TaskTab) => void
  projectName: string
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teamName: string
  userInitial: string
}) {
  const openTaskCount = tasks.filter((task) => resolveProjectTaskStatus(task) !== 'done').length
  const reviewTaskCount = tasks.filter((task) => resolveProjectTaskStatus(task) === 'review').length
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: TaskTab) => {
    const tabIndex = taskTabs.indexOf(tab)
    let nextTabIndex: number | undefined

    if (event.key === 'ArrowRight') {
      nextTabIndex = (tabIndex + 1) % taskTabs.length
    } else if (event.key === 'ArrowLeft') {
      nextTabIndex = (tabIndex - 1 + taskTabs.length) % taskTabs.length
    } else if (event.key === 'Home') {
      nextTabIndex = 0
    } else if (event.key === 'End') {
      nextTabIndex = taskTabs.length - 1
    }

    if (nextTabIndex === undefined) {
      return
    }

    event.preventDefault()
    const nextTab = taskTabs[nextTabIndex]

    onTabChange(nextTab)
    document.getElementById(createTaskTabId(nextTab))?.focus()
  }

  return (
    <header className="workbench-header flex-none">
      <div className="flex min-h-[68px] items-center justify-between gap-4 px-[clamp(18px,2.5vw,30px)] py-3">
        <div className="flex min-w-0 items-center gap-3">
          <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={onMobileSidebarOpen} />
          <div className="min-w-0">
            <nav
              aria-label={t('tasks.breadcrumb.aria')}
              className="flex flex-wrap items-center gap-2 text-app-caption font-semibold text-[var(--workbench-muted)]"
            >
              <span>{teamName || t('sidebar.projectGroup')}</span>
              <ChevronIcon className="h-4 w-4 -rotate-90 text-[var(--workbench-muted-soft)]" />
              <span className="inline-flex items-center gap-2 font-semibold text-[var(--workbench-text)]">
                <ProjectGlyph />
                {projectName}
              </span>
            </nav>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1
                className="workbench-title truncate text-[1.35rem] leading-8"
                data-testid="tasks-heading"
              >
                {projectName}
              </h1>
              <span className="workbench-badge">
                {t('tasks.count').replace('{count}', String(tasks.length))}
              </span>
              <span className="workbench-badge">
                {t('workspace.metric.openTasks')}: {openTaskCount}
              </span>
              <span className="workbench-badge-warning">
                {t('tasks.status.review')}: {reviewTaskCount}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-2">
          <span className="contents max-[860px]:hidden">
            <IconButton label={t('tasks.action.favorite')}>
              <StarIcon />
            </IconButton>
            <IconButton label={t('tasks.action.more')}>
              <MoreIcon />
            </IconButton>
          </span>
          <button
            className="workbench-button-secondary inline-flex h-9 items-center gap-2 px-3 max-[860px]:hidden"
            type="button"
          >
            <UsersMiniIcon />
            {t('tasks.action.share')}
          </button>
          {onCreateTaskOpenChange ? (
            <button
              aria-controls={isCreateTaskOpen ? 'create-task-form' : undefined}
              aria-expanded={isCreateTaskOpen}
              className="workbench-button-primary inline-flex h-10 items-center justify-center gap-2 px-3.5 max-[520px]:w-10 max-[520px]:px-0"
              onClick={() => onCreateTaskOpenChange(!isCreateTaskOpen)}
              type="button"
            >
              <PlusIcon />
              <span className="max-[520px]:sr-only">{t('tasks.action.newTask')}</span>
              <ChevronIcon className="h-4 w-4 max-[520px]:hidden" />
            </button>
          ) : null}
          <span className="max-[860px]:hidden">
            <IconButton label={t('tasks.action.notifications')} rounded>
              <BellOutlineIcon />
            </IconButton>
          </span>
          <div
            aria-label={t('tasks.userAvatar')}
            className="grid h-9 w-9 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)] max-[860px]:hidden"
          >
            {userInitial}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 overflow-x-auto border-t border-[var(--workbench-border)] px-[clamp(18px,2.5vw,30px)]">
        <div aria-label={t('tasks.tabs.aria')} className="flex min-w-max items-center gap-0" role="tablist">
          {taskTabs.map((tab) => (
            <button
              aria-controls={taskTabPanelId}
              aria-selected={activeTab === tab}
              className={`relative inline-flex h-11 items-center gap-2 border-r border-transparent px-3.5 text-app-caption font-semibold transition ${
                activeTab === tab ? 'text-[var(--workbench-text)]' : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              id={createTaskTabId(tab)}
              key={tab}
              onClick={() => onTabChange(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              role="tab"
              tabIndex={activeTab === tab ? 0 : -1}
              type="button"
            >
              <TabIcon tab={tab} />
              {t(`tasks.tab.${tab}`)}
              {activeTab === tab ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 bottom-0 h-0.5 rounded-t-full bg-[var(--workbench-primary)]"
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
  allTasks,
  assigneeFilter,
  canManageProjectMembers,
  dueDateFilter,
  isAssigneeMenuOpen,
  isDueDateMenuOpen,
  isPriorityMenuOpen,
  isSortMenuOpen,
  isStatusMenuOpen,
  isProjectMembersLoading,
  isProjectUsersLoading,
  isSystemAdmin,
  priorityFilter,
  projectId,
  projectMembers,
  projectMembersErrorMessage,
  projectName,
  projectUserQuery,
  projectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  selectedDetailTaskId,
  sortOrder,
  onAssigneeFilterChange,
  onAssigneeMenuOpenChange,
  onDueDateFilterChange,
  onDueDateMenuOpenChange,
  onLoadMoreProjectUsers,
  onCreateTaskOpen,
  onPriorityFilterChange,
  onPriorityMenuOpenChange,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onSearchQueryChange,
  onSelectTask,
  onSortMenuOpenChange,
  onSortOrderChange,
  onStatusFilterChange,
  onStatusMenuOpenChange,
  onTaskSelectionChange,
  onUpdateProjectMember,
  searchQuery,
  selectedTaskIds,
  statusFilter,
  t,
  taskErrorMessage,
  tasks,
}: {
  activeTab: TaskTab
  allTasks: ProjectTask[]
  assigneeFilter: AssigneeFilter
  canManageProjectMembers: boolean
  dueDateFilter: DueDateFilter
  isAssigneeMenuOpen: boolean
  isDueDateMenuOpen: boolean
  isPriorityMenuOpen: boolean
  isSortMenuOpen: boolean
  isStatusMenuOpen: boolean
  isProjectMembersLoading: boolean
  isProjectUsersLoading: boolean
  isSystemAdmin: boolean
  priorityFilter: PriorityFilter
  projectId: string
  projectMembers: ProjectMember[]
  projectMembersErrorMessage?: string
  projectName: string
  projectUserQuery: string
  projectUsers: ProjectUser[]
  projectUsersErrorMessage?: string
  projectUsersNextToken?: string
  selectedDetailTaskId?: string
  sortOrder: TaskSortOrder
  onAssigneeFilterChange: (assigneeFilter: AssigneeFilter) => void
  onAssigneeMenuOpenChange: (isOpen: boolean) => void
  onDueDateFilterChange: (dueDateFilter: DueDateFilter) => void
  onDueDateMenuOpenChange: (isOpen: boolean) => void
  onLoadMoreProjectUsers?: () => Promise<void>
  onCreateTaskOpen?: () => void
  onPriorityFilterChange: (priorityFilter: PriorityFilter) => void
  onPriorityMenuOpenChange: (isOpen: boolean) => void
  onProjectUserQueryChange?: (query: string) => void
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  onSearchQueryChange: (query: string) => void
  onSelectTask: (task: ProjectTask) => void
  onSortMenuOpenChange: (isOpen: boolean) => void
  onSortOrderChange: (sortOrder: TaskSortOrder) => void
  onStatusFilterChange: (statusFilter: StatusFilter) => void
  onStatusMenuOpenChange: (isOpen: boolean) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
  searchQuery: string
  selectedTaskIds: string[]
  statusFilter: StatusFilter
  t: (key: MessageKey) => string
  taskErrorMessage?: string
  tasks: ProjectTask[]
}) {
  const statusFilterButtonId = 'status-filter-button'
  const statusFilterMenuId = 'status-filter-menu'
  const assigneeFilterButtonId = 'assignee-filter-button'
  const assigneeFilterMenuId = 'assignee-filter-menu'
  const priorityFilterButtonId = 'priority-filter-button'
  const priorityFilterMenuId = 'priority-filter-menu'
  const dueDateFilterButtonId = 'due-date-filter-button'
  const dueDateFilterMenuId = 'due-date-filter-menu'
  const sortButtonId = 'task-sort-button'
  const sortMenuId = 'task-sort-menu'
  const assigneeOptions = createAssigneeFilterOptions(allTasks, t)
  const statusMenuRef = useRef<HTMLDivElement>(null)
  const assigneeMenuRef = useRef<HTMLDivElement>(null)
  const dueDateMenuRef = useRef<HTMLDivElement>(null)
  const priorityMenuRef = useRef<HTMLDivElement>(null)
  const sortMenuRef = useRef<HTMLDivElement>(null)

  const handleMenuOpenChange = (
    menu: 'status' | 'assignee' | 'dueDate' | 'priority' | 'sort',
    isOpen: boolean,
  ) => {
    onStatusMenuOpenChange(menu === 'status' && isOpen)
    onAssigneeMenuOpenChange(menu === 'assignee' && isOpen)
    onDueDateMenuOpenChange(menu === 'dueDate' && isOpen)
    onPriorityMenuOpenChange(menu === 'priority' && isOpen)
    onSortMenuOpenChange(menu === 'sort' && isOpen)
  }

  useEffect(() => {
    const openMenus = [
      {
        buttonId: statusFilterButtonId,
        close: onStatusMenuOpenChange,
        containerRef: statusMenuRef,
        isOpen: isStatusMenuOpen,
      },
      {
        buttonId: assigneeFilterButtonId,
        close: onAssigneeMenuOpenChange,
        containerRef: assigneeMenuRef,
        isOpen: isAssigneeMenuOpen,
      },
      {
        buttonId: dueDateFilterButtonId,
        close: onDueDateMenuOpenChange,
        containerRef: dueDateMenuRef,
        isOpen: isDueDateMenuOpen,
      },
      {
        buttonId: priorityFilterButtonId,
        close: onPriorityMenuOpenChange,
        containerRef: priorityMenuRef,
        isOpen: isPriorityMenuOpen,
      },
      {
        buttonId: sortButtonId,
        close: onSortMenuOpenChange,
        containerRef: sortMenuRef,
        isOpen: isSortMenuOpen,
      },
    ].filter((menu) => menu.isOpen)

    if (openMenus.length === 0) {
      return
    }

    const focusTrigger = (menu: (typeof openMenus)[number]) => {
      document.getElementById(menu.buttonId)?.focus()
    }
    const closeOpenMenus = () => {
      openMenus.forEach((menu) => menu.close(false))
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      const focusedMenu = openMenus.find((menu) =>
        menu.containerRef.current?.contains(document.activeElement),
      )
      closeOpenMenus()
      focusTrigger(focusedMenu ?? openMenus[0])
    }
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Node &&
        openMenus.some((menu) => menu.containerRef.current?.contains(event.target as Node))
      ) {
        return
      }

      closeOpenMenus()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [
    assigneeFilterButtonId,
    assigneeMenuRef,
    dueDateFilterButtonId,
    dueDateMenuRef,
    isAssigneeMenuOpen,
    isDueDateMenuOpen,
    isPriorityMenuOpen,
    isSortMenuOpen,
    isStatusMenuOpen,
    onAssigneeMenuOpenChange,
    onDueDateMenuOpenChange,
    onPriorityMenuOpenChange,
    onSortMenuOpenChange,
    onStatusMenuOpenChange,
    priorityFilterButtonId,
    priorityMenuRef,
    sortButtonId,
    sortMenuRef,
    statusFilterButtonId,
    statusMenuRef,
  ])

  if (activeTab === 'permissions') {
    return (
      <div className="px-[clamp(18px,2.5vw,30px)] py-4">
        <ProjectPermissionsPanel
          canManageMembers={canManageProjectMembers}
          errorMessage={projectMembersErrorMessage}
          isLoading={isProjectMembersLoading}
          isSystemAdmin={isSystemAdmin}
          isUsersLoading={isProjectUsersLoading}
          members={projectMembers}
          projectId={projectId}
          projectName={projectName}
          t={t}
          userQuery={projectUserQuery}
          users={projectUsers}
          usersErrorMessage={projectUsersErrorMessage}
          usersNextToken={projectUsersNextToken}
          onLoadMoreUsers={onLoadMoreProjectUsers}
          onRemoveMember={onRemoveProjectMember}
          onUpdateMember={onUpdateProjectMember}
          onUserQueryChange={onProjectUserQueryChange}
        />
      </div>
    )
  }

  if (activeTab === 'file') {
    return (
      <div className="px-[clamp(18px,2.5vw,30px)] py-4">
        <TaskFileList t={t} tasks={tasks} />
      </div>
    )
  }

  return (
    <div className="px-[clamp(18px,2.5vw,30px)] py-4">
      <div className="workbench-toolbar flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block">
            <span className="sr-only">{t('tasks.search')}</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5f6874]" />
            <input
              aria-label={t('tasks.search')}
              className="workbench-input h-9 w-[min(250px,calc(100vw-52px))] pl-9 pr-3 placeholder:text-[var(--workbench-muted-soft)]"
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={t('tasks.search')}
              type="search"
              value={searchQuery}
            />
          </label>
          <FilterButton
            icon={<FilterIcon />}
            label={t('tasks.filter.all')}
            onClick={() => {
              onStatusFilterChange('all')
              onAssigneeFilterChange('all')
              onPriorityFilterChange('all')
              onDueDateFilterChange('all')
            }}
          />
          <div className="relative" ref={statusMenuRef}>
            <FilterButton
              active={statusFilter !== 'all'}
              ariaControls={statusFilterMenuId}
              ariaExpanded={isStatusMenuOpen}
              ariaHaspopup="menu"
              icon={<StatusIcon />}
              id={statusFilterButtonId}
              label={t('tasks.filter.status')}
              onClick={() => handleMenuOpenChange('status', !isStatusMenuOpen)}
            />
            {isStatusMenuOpen ? (
              <div
                aria-labelledby={statusFilterButtonId}
                className="absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)]"
                id={statusFilterMenuId}
                role="menu"
              >
                {(['all', ...taskStatuses] as const).map((status) => (
                  <button
                    aria-checked={statusFilter === status}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      statusFilter === status
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
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
          <div className="relative" ref={assigneeMenuRef}>
            <FilterButton
              active={assigneeFilter !== 'all'}
              ariaControls={assigneeFilterMenuId}
              ariaExpanded={isAssigneeMenuOpen}
              ariaHaspopup="menu"
              icon={<AssigneeIcon />}
              id={assigneeFilterButtonId}
              label={t('tasks.filter.assignee')}
              onClick={() => handleMenuOpenChange('assignee', !isAssigneeMenuOpen)}
            />
            {isAssigneeMenuOpen ? (
              <div
                aria-labelledby={assigneeFilterButtonId}
                className="absolute left-0 z-20 mt-2 max-h-80 w-64 overflow-auto rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)]"
                id={assigneeFilterMenuId}
                role="menu"
              >
                {assigneeOptions.map((option) => (
                  <button
                    aria-checked={assigneeFilter === option.value}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      assigneeFilter === option.value
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
                    }`}
                    key={option.value}
                    onClick={() => onAssigneeFilterChange(option.value)}
                    role="menuitemradio"
                    type="button"
                  >
                    {option.label}
                    {assigneeFilter === option.value ? <CheckIcon /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative" ref={dueDateMenuRef}>
            <FilterButton
              active={dueDateFilter !== 'all'}
              ariaControls={dueDateFilterMenuId}
              ariaExpanded={isDueDateMenuOpen}
              ariaHaspopup="menu"
              icon={<CalendarIcon />}
              id={dueDateFilterButtonId}
              label={t('tasks.filter.dueDate')}
              onClick={() => handleMenuOpenChange('dueDate', !isDueDateMenuOpen)}
            />
            {isDueDateMenuOpen ? (
              <div
                aria-labelledby={dueDateFilterButtonId}
                className="absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)]"
                id={dueDateFilterMenuId}
                role="menu"
              >
                {taskDueDateFilters.map((filter) => (
                  <button
                    aria-checked={dueDateFilter === filter}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      dueDateFilter === filter
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
                    }`}
                    key={filter}
                    onClick={() => onDueDateFilterChange(filter)}
                    role="menuitemradio"
                    type="button"
                  >
                    {t(resolveDueDateFilterLabelKey(filter))}
                    {dueDateFilter === filter ? <CheckIcon /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative" ref={priorityMenuRef}>
            <FilterButton
              active={priorityFilter !== 'all'}
              ariaControls={priorityFilterMenuId}
              ariaExpanded={isPriorityMenuOpen}
              ariaHaspopup="menu"
              icon={<FlagIcon />}
              id={priorityFilterButtonId}
              label={t('tasks.filter.priority')}
              onClick={() => handleMenuOpenChange('priority', !isPriorityMenuOpen)}
            />
            {isPriorityMenuOpen ? (
              <div
                aria-labelledby={priorityFilterButtonId}
                className="absolute left-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)]"
                id={priorityFilterMenuId}
                role="menu"
              >
                {(['all', ...taskPriorities] as const).map((priority) => (
                  <button
                    aria-checked={priorityFilter === priority}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      priorityFilter === priority
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
                    }`}
                    key={priority}
                    onClick={() => onPriorityFilterChange(priority)}
                    role="menuitemradio"
                    type="button"
                  >
                    {priority === 'all' ? t('tasks.filter.priorityAll') : t(`tasks.priority.${priority}`)}
                    {priorityFilter === priority ? <CheckIcon /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative" ref={sortMenuRef}>
            <FilterButton
              ariaControls={sortMenuId}
              ariaExpanded={isSortMenuOpen}
              ariaHaspopup="menu"
              icon={<CalendarIcon />}
              id={sortButtonId}
              label={t(resolveTaskSortOrderLabelKey(sortOrder))}
              onClick={() => handleMenuOpenChange('sort', !isSortMenuOpen)}
            />
            {isSortMenuOpen ? (
              <div
                aria-labelledby={sortButtonId}
                className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-md border border-[#d3d8df] bg-white p-1 shadow-[0_12px_24px_rgba(28,40,64,0.12)]"
                id={sortMenuId}
                role="menu"
              >
                {taskSortOrders.map((order) => (
                  <button
                    aria-checked={sortOrder === order}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      sortOrder === order
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
                    }`}
                    key={order}
                    onClick={() => onSortOrderChange(order)}
                    role="menuitemradio"
                    type="button"
                  >
                    {t(resolveTaskSortOrderLabelKey(order))}
                    {sortOrder === order ? <CheckIcon /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {taskErrorMessage && activeTab !== 'table' ? (
        <p
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-5 py-4 text-sm font-semibold text-red-700"
          data-testid="tasks-error"
          role="alert"
        >
          {taskErrorMessage === t('tasks.error.loading')
            ? taskErrorMessage
            : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
        </p>
      ) : null}

      {activeTab === 'table' ? (
        <TaskTable
          selectedDetailTaskId={selectedDetailTaskId}
          selectedTaskIds={selectedTaskIds}
          onCreateTaskOpen={onCreateTaskOpen}
          onSelectTask={onSelectTask}
          onTaskSelectionChange={onTaskSelectionChange}
          t={t}
          taskErrorMessage={taskErrorMessage}
          tasks={tasks}
        />
      ) : null}
      {activeTab === 'board' && !taskErrorMessage ? (
        <TaskBoard
          selectedDetailTaskId={selectedDetailTaskId}
          t={t}
          tasks={tasks}
          onSelectTask={onSelectTask}
        />
      ) : null}
      {activeTab === 'gantt' && !taskErrorMessage ? <TaskGantt t={t} tasks={tasks} /> : null}
      {activeTab === 'calendar' && !taskErrorMessage ? <TaskCalendar t={t} tasks={tasks} /> : null}
    </div>
  )
}
