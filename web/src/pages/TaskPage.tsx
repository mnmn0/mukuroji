import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  isActiveProjectAssignmentCandidate,
  type ProjectDirectoryTeam,
  type ProjectMember,
  type ProjectUser,
  type UpdateProjectMemberInput,
  removeProjectMember,
  updateProjectMember,
} from '../projects/api'
import {
  createTeamIssue,
  getTeamIssueDetail,
  getProjectIssues,
  TeamIssuesApiError,
  type TeamIssue,
  type TeamIssueDetail,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../issues/api'
import { IssueCollaborationPanel } from '../issues/IssueCollaborationPanel'
import {
  type IssueCollaborationController,
  useIssueCollaboration,
} from '../issues/useIssueCollaboration'
import { ProjectPermissionsPanel } from '../projects/ProjectPermissionsPanel'
import {
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../routes/paths'
import {
  type CreateProjectTaskInput,
  ProjectTasksApiError,
  type ProjectTask,
  type TaskPriority,
  type TaskStatus,
} from '../tasks/api'
import { getWorkspaceAccess, type WorkspaceMember } from '../workspace/api'

const taskTabs = ['table', 'board', 'gantt', 'calendar', 'file', 'permissions'] as const
const taskStatuses = ['in-progress', 'review', 'todo', 'done'] as const
const taskPriorities = ['high', 'medium', 'low'] as const
const taskDueDateFilters = ['all', 'overdue', 'upcoming', 'no-date'] as const
const taskSortOrders = ['due-date-asc', 'due-date-desc'] as const
const emptyProjectMembers: ProjectMember[] = []
const emptyProjectUsers: ProjectUser[] = []
const emptyTeamIssues: TeamIssue[] = []
const emptyWorkspaceMembers: WorkspaceMember[] = []
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
 * 担当者絞り込みの選択値です。
 */
type AssigneeFilter = string | 'all'

/**
 * 優先度絞り込みの選択値です。
 */
type PriorityFilter = TaskPriority | 'all'

/**
 * 期限バケット絞り込みの選択値です。
 */
type DueDateFilter = (typeof taskDueDateFilters)[number]

/**
 * タスク一覧の期限並び替え方向です。
 */
type TaskSortOrder = (typeof taskSortOrders)[number]

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
 * 担当者絞り込みメニューの選択肢です。
 */
type AssigneeFilterOption = {
  /**
   * 絞り込みに使う担当者識別値です。
   */
  value: AssigneeFilter
  /**
   * メニューに表示する担当者名です。
   */
  label: string
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

const viewLabelKeys: Record<TaskTab, MessageKey> = {
  table: 'tasks.view.table',
  board: 'tasks.view.board',
  gantt: 'tasks.view.gantt',
  calendar: 'tasks.view.calendar',
  file: 'tasks.view.file',
  permissions: 'tasks.view.permissions',
}

/**
 * Cognito 認証後に表示するタスク専用ページです。
 */
export function TaskPage() {
  const navigate = useNavigate()
  const params = useParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? 'refero'
  const selectedTeamId = searchParams.get('teamId') ?? undefined
  const selectedIssueId = searchParams.get('issueId') ?? undefined
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
  const tasks = useMemo(
    () => projectIssues.map((issue) => toProjectTaskFromIssue(issue, projectId)),
    [projectId, projectIssues],
  )
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
  const detailErrorMessage = detailError
    ? t('tasks.detail.error')
    : undefined
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

    navigate(createProjectIssuesPath(task.projectId ?? projectId, nextTeamId, task.id))
  }

  const handleUpdateIssue = async (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => {
    if (!accessToken) {
      return
    }

    await mutationRequestRunner.run(
      `issue:update:${teamId}:${issueId}`,
      JSON.stringify(input),
      (context) => updateTeamIssue(teamId, issueId, accessToken, input, context),
    )
    await mutateProjectTasks()
    await mutateSelectedIssueDetail()
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
  assigneeErrorMessage,
  assigneeOptions = [],
  canManageProjectMembers = false,
  collaboration,
  currentWorkspaceMemberKey,
  defaultCreateTaskOpen = false,
  detailErrorMessage,
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
  const taskContentRef = useRef<HTMLDivElement>(null)
  const resolvedProjectName = projectName ?? projectId
  const resolvedActiveTeam = findTeamForProject(teams, projectId, activeProjectTeamId)
  const resolvedActiveTeamId = activeProjectTeamId ?? resolvedActiveTeam?.id
  const resolvedTeamName = teamName ?? resolvedActiveTeam?.name ?? ''
  const activeTeamProjects = resolvedActiveTeam?.projects ?? []
  const selectedDetailTaskId = localSelectedDetailTaskId ?? initialSelectedTaskId
  const visibleTasks = useMemo(
    () => {
      const filteredTasks = tasks.filter((task) => {
        const matchesStatus = statusFilter === 'all' || task.status === statusFilter
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
          t(`tasks.status.${task.status}`),
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
        inboxCount={tasks.filter((task) => task.status === 'review' || task.priority === 'high').length}
        labels={sidebarLabels}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
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
          inboxCount={tasks.filter((task) => task.status === 'review' || task.priority === 'high').length}
          labels={sidebarLabels}
          onArchiveProject={onArchiveProject}
          onArchiveTeam={onArchiveTeam}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
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
            <div className={`grid min-h-full ${activeTab === 'permissions' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(360px,440px)] max-[1180px]:grid-cols-1'}`}>
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
              {activeTab === 'permissions' ? null : (
                <TaskDetailPane
                  assigneeOptions={assigneeOptions}
                  collaboration={collaboration}
                  currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                  detail={selectedIssueDetail}
                  errorMessage={detailErrorMessage}
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

function toProjectTaskFromIssue(issue: TeamIssue, projectId: string): ProjectTask {
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

function normalizeProjectIssueError(error: unknown) {
  if (error instanceof TeamIssuesApiError && error.message === 'issues.error.loading') {
    return new ProjectTasksApiError(error.status, 'tasks.error.loading')
  }

  return error
}

function findIssueBySelection(
  issues: TeamIssue[],
  selectedIssueId?: string,
  selectedTeamId?: string,
) {
  if (!selectedIssueId) {
    return undefined
  }

  return issues.find((issue) =>
    issue.id === selectedIssueId && (!selectedTeamId || issue.teamId === selectedTeamId),
  )
}

function findTaskBySelection(
  tasks: ProjectTask[],
  selectedTaskId?: string,
  selectedTeamId?: string,
) {
  if (!selectedTaskId) {
    return undefined
  }

  return tasks.find((task) =>
    task.id === selectedTaskId && (!selectedTeamId || task.teamId === selectedTeamId),
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
  const openTaskCount = tasks.filter((task) => task.status !== 'done').length
  const reviewTaskCount = tasks.filter((task) => task.status === 'review').length

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

        <div className="flex flex-none items-center gap-2 max-[860px]:hidden">
          <IconButton label={t('tasks.action.favorite')}>
            <StarIcon />
          </IconButton>
          <IconButton label={t('tasks.action.more')}>
            <MoreIcon />
          </IconButton>
          <button
            className="workbench-button-secondary inline-flex h-9 items-center gap-2 px-3"
            type="button"
          >
            <UsersMiniIcon />
            {t('tasks.action.share')}
          </button>
          {onCreateTaskOpenChange ? (
            <button
              aria-controls={isCreateTaskOpen ? 'create-task-form' : undefined}
              aria-expanded={isCreateTaskOpen}
              className="workbench-button-primary inline-flex h-9 items-center gap-2 px-3.5"
              onClick={() => onCreateTaskOpenChange(!isCreateTaskOpen)}
              type="button"
            >
              <PlusIcon />
              {t('tasks.action.newTask')}
              <ChevronIcon className="h-4 w-4" />
            </button>
          ) : null}
          <IconButton label={t('tasks.action.notifications')} rounded>
            <BellOutlineIcon />
          </IconButton>
          <div
            aria-label={t('tasks.userAvatar')}
            className="grid h-9 w-9 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]"
          >
            {userInitial}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 overflow-x-auto border-t border-[var(--workbench-border)] px-[clamp(18px,2.5vw,30px)]">
        <div aria-label={t('tasks.tabs.aria')} className="flex min-w-max items-center gap-0" role="tablist">
          {taskTabs.map((tab) => (
            <button
              aria-selected={activeTab === tab}
              className={`relative inline-flex h-11 items-center gap-2 border-r border-transparent px-3.5 text-app-caption font-semibold transition ${
                activeTab === tab ? 'text-[var(--workbench-text)]' : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
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
          <div className="relative">
            <FilterButton
              active={assigneeFilter !== 'all'}
              ariaControls={assigneeFilterMenuId}
              ariaExpanded={isAssigneeMenuOpen}
              ariaHaspopup="menu"
              icon={<AssigneeIcon />}
              id={assigneeFilterButtonId}
              label={t('tasks.filter.assignee')}
              onClick={() => onAssigneeMenuOpenChange(!isAssigneeMenuOpen)}
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
          <div className="relative">
            <FilterButton
              active={dueDateFilter !== 'all'}
              ariaControls={dueDateFilterMenuId}
              ariaExpanded={isDueDateMenuOpen}
              ariaHaspopup="menu"
              icon={<CalendarIcon />}
              id={dueDateFilterButtonId}
              label={t('tasks.filter.dueDate')}
              onClick={() => onDueDateMenuOpenChange(!isDueDateMenuOpen)}
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
          <div className="relative">
            <FilterButton
              active={priorityFilter !== 'all'}
              ariaControls={priorityFilterMenuId}
              ariaExpanded={isPriorityMenuOpen}
              ariaHaspopup="menu"
              icon={<FlagIcon />}
              id={priorityFilterButtonId}
              label={t('tasks.filter.priority')}
              onClick={() => onPriorityMenuOpenChange(!isPriorityMenuOpen)}
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
          <div className="relative">
            <FilterButton
              ariaControls={sortMenuId}
              ariaExpanded={isSortMenuOpen}
              ariaHaspopup="menu"
              icon={<CalendarIcon />}
              id={sortButtonId}
              label={t(resolveTaskSortOrderLabelKey(sortOrder))}
              onClick={() => onSortMenuOpenChange(!isSortMenuOpen)}
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
          <button
            className="workbench-button-secondary inline-flex h-9 items-center gap-2 px-3"
            type="button"
          >
            <SettingsMiniIcon />
            {t('tasks.viewSettings')}
          </button>
        </div>
      </div>

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
      {activeTab === 'board' ? (
        <TaskBoard
          selectedDetailTaskId={selectedDetailTaskId}
          t={t}
          tasks={tasks}
          onSelectTask={onSelectTask}
        />
      ) : null}
      {activeTab === 'gantt' ? <TaskGantt t={t} tasks={tasks} /> : null}
      {activeTab === 'calendar' ? <TaskCalendar t={t} tasks={tasks} /> : null}
      {activeTab === 'file' ? <TaskFileList t={t} tasks={tasks} /> : null}
    </div>
  )
}

function CreateTaskPanel({
  assigneeErrorMessage,
  assigneeOptions,
  errorMessage,
  isAssigneeOptionsLoading,
  isSubmitting,
  onCancel,
  onSubmit,
  t,
}: {
  assigneeErrorMessage?: string
  assigneeOptions: ProjectMember[]
  errorMessage?: string
  isAssigneeOptionsLoading: boolean
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (input: CreateProjectTaskInput) => Promise<void>
  t: (key: MessageKey) => string
}) {
  const today = new Date().toISOString().slice(0, 10)

  return (
    <section className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-[clamp(18px,2.5vw,30px)] py-3">
      <form
        className="workbench-panel grid gap-3 p-4"
        data-testid="create-task-form"
        onSubmit={(event) => {
          event.preventDefault()

          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? today).replaceAll('-', '/')
          const status = resolveTaskStatus(formData.get('status'))
          const priority = resolveTaskPriority(formData.get('priority'))

          if (!assigneeUserId) {
            event.currentTarget.reportValidity()
            return
          }

          void onSubmit({
            title,
            assigneeUserId,
            dueDate,
            status,
            priority,
          })
        }}
      >
        <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(180px,0.9fr)_150px_150px_150px_auto] gap-3 max-[1180px]:grid-cols-2 max-[720px]:grid-cols-1">
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.create.title')}
            <input
              className="workbench-input h-10 px-3"
              name="title"
              placeholder={t('tasks.create.titlePlaceholder')}
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.create.assignee')}
            <select
              className="workbench-input h-10 px-3"
              defaultValue=""
              disabled={isSubmitting || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage)}
              name="assigneeUserId"
              required
            >
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
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.column.dueDate')}
            <input
              className="workbench-input h-10 px-3"
              defaultValue={today}
              name="dueDate"
              required
              type="date"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.column.status')}
            <select
              className="workbench-input h-10 px-3"
              defaultValue="todo"
              name="status"
            >
              {taskStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`tasks.status.${status}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.column.priority')}
            <select
              className="workbench-input h-10 px-3"
              defaultValue="medium"
              name="priority"
            >
              {taskPriorities.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`tasks.priority.${priority}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button
              className="workbench-button-primary h-10 px-4 disabled:cursor-not-allowed disabled:border-[#b5bdc9] disabled:bg-[#b5bdc9]"
              disabled={
                isSubmitting ||
                isAssigneeOptionsLoading ||
                Boolean(assigneeErrorMessage) ||
                assigneeOptions.length === 0
              }
              type="submit"
            >
              {isSubmitting ? t('tasks.create.saving') : t('tasks.create.submit')}
            </button>
            <button
              className="workbench-button-secondary h-10 px-4"
              disabled={isSubmitting}
              onClick={onCancel}
              type="button"
            >
              {t('tasks.create.cancel')}
            </button>
          </div>
        </div>
        {errorMessage ? (
          <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
        ) : null}
        {isAssigneeOptionsLoading ? (
          <p className="text-sm font-medium text-[#5f6874]">{t('tasks.create.assigneeLoading')}</p>
        ) : null}
        {assigneeErrorMessage ? (
          <p className="text-sm font-semibold text-red-700">{assigneeErrorMessage}</p>
        ) : null}
        {!isAssigneeOptionsLoading && !assigneeErrorMessage && assigneeOptions.length === 0 ? (
          <p className="text-sm font-medium text-[#5f6874]">{t('tasks.create.assigneeEmpty')}</p>
        ) : null}
      </form>
    </section>
  )
}

function resolveTaskStatus(value: FormDataEntryValue | null): TaskStatus {
  if (typeof value === 'string' && taskStatuses.includes(value as TaskStatus)) {
    return value as TaskStatus
  }

  return 'todo'
}

function resolveTaskPriority(value: FormDataEntryValue | null): TaskPriority {
  if (typeof value === 'string' && taskPriorities.includes(value as TaskPriority)) {
    return value as TaskPriority
  }

  return 'medium'
}

function TaskTable({
  selectedDetailTaskId,
  selectedTaskIds,
  onCreateTaskOpen,
  onSelectTask,
  onTaskSelectionChange,
  t,
  taskErrorMessage,
  tasks,
}: {
  selectedDetailTaskId?: string
  selectedTaskIds: string[]
  onCreateTaskOpen?: () => void
  onSelectTask: (task: ProjectTask) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  t: (key: MessageKey) => string
  taskErrorMessage?: string
  tasks: ProjectTask[]
}) {
  const hasTaskRows = !taskErrorMessage && tasks.length > 0

  return (
    <section
      aria-label={t('tasks.table.aria')}
      className="workbench-table mt-3 overflow-hidden"
    >
      <div className="overflow-x-auto">
        <table className={`w-full table-fixed border-collapse ${hasTaskRows ? 'min-w-[720px]' : 'min-w-0'}`}>
          {hasTaskRows ? (
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[20%]" />
              <col className="w-[13%]" />
              <col className="w-[15%]" />
              <col className="w-[14%]" />
              <col className="w-[4%]" />
            </colgroup>
          ) : null}
          {hasTaskRows ? (
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-2.5" scope="col">
                  <span className="inline-flex items-center gap-2">
                    {t('tasks.column.name')}
                    <span aria-hidden="true" className="text-[#8f99a8]">
                      ↕
                    </span>
                  </span>
                </th>
                <th className="px-3 py-2.5" scope="col">
                  {t('tasks.column.assignee')}
                </th>
                <th className="px-3 py-2.5" scope="col">
                  {t('tasks.column.status')}
                </th>
                <th className="px-3 py-2.5" scope="col">
                  {t('tasks.column.dueDate')}
                </th>
                <th className="px-3 py-2.5" scope="col">
                  {t('tasks.column.priority')}
                </th>
                <th className="px-3 py-2.5 text-center text-lg text-[#8f99a8]" scope="col">
                  +
                </th>
              </tr>
            </thead>
          ) : null}
          <tbody>
            {taskErrorMessage ? (
              <tr>
                <td
                  className="break-words px-5 py-7 text-sm font-semibold text-red-700"
                  colSpan={6}
                  data-testid="tasks-error"
                >
                  {taskErrorMessage === t('tasks.error.loading')
                    ? taskErrorMessage
                    : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
                </td>
              </tr>
            ) : tasks.length > 0 ? (
              tasks.map((task, index) => (
                <TaskRow
                  key={createTaskKey(task)}
                  rowIndex={index}
                  onTaskSelectionChange={onTaskSelectionChange}
                  onSelectTask={onSelectTask}
                  selectedForDetail={selectedDetailTaskId === task.id}
                  selected={selectedTaskIds.includes(task.id)}
                  t={t}
                  task={task}
                />
              ))
            ) : (
              <tr>
                <td
                  className="px-5 py-7 text-sm font-medium text-[#5f6874]"
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
      <div className="grid grid-cols-[1fr_auto] items-center border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-3 text-sm font-medium">
        {onCreateTaskOpen ? (
          <button
            className="inline-flex items-center gap-2 text-[var(--workbench-primary)] transition hover:text-[var(--workbench-primary-hover)]"
            onClick={onCreateTaskOpen}
            type="button"
          >
            <PlusIcon className="h-5 w-5" />
            {t('tasks.addTask')}
          </button>
        ) : <span />}
        <span className="text-[#5f6874]" data-testid="tasks-count">
          {t('tasks.count').replace('{count}', String(tasks.length))}
        </span>
      </div>
    </section>
  )
}

function TaskBoard({
  selectedDetailTaskId,
  onSelectTask,
  t,
  tasks,
}: {
  selectedDetailTaskId?: string
  onSelectTask: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
}) {
  return (
    <section
      aria-label={t(viewLabelKeys.board)}
      className="mt-3 grid grid-cols-4 gap-3 max-[1180px]:grid-cols-2 max-[720px]:grid-cols-1"
    >
      <ViewHeading
        className="col-span-full"
        count={tasks.length}
        t={t}
        titleKey={viewLabelKeys.board}
      />
      {taskStatuses.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status)

        return (
          <div
            className="workbench-panel min-h-[420px]"
            key={status}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5">
              <TaskStatusBadge status={status} t={t} />
              <span className="text-sm font-semibold text-[#5f6874]">
                {t('tasks.board.columnCount').replace('{count}', String(statusTasks.length))}
              </span>
            </div>
            <div className="grid gap-2 p-2.5">
              {statusTasks.length > 0 ? (
                statusTasks.map((task) => (
                  <button
                    className={`rounded-md border p-3 text-left transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
                      selectedDetailTaskId === task.id
                        ? 'border-[#99d7cf] bg-[#e5f7f4] shadow-[inset_3px_0_0_var(--workbench-primary)]'
                        : 'border-[var(--workbench-border)] bg-white hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]'
                    }`}
                    key={createTaskKey(task)}
                    onClick={() => onSelectTask(task)}
                    type="button"
                  >
                    <p className="text-sm font-semibold leading-5 text-[#1c1d1f]">{resolveTaskTitle(task, t)}</p>
                    <p className="mt-2 truncate text-xs font-medium text-[#5f6874]">
                      {resolveTaskAssignee(task, t)}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <TaskPriorityBadge priority={task.priority} t={t} />
                      <span className="text-xs font-semibold text-[#5f6874]">{task.dueDate}</span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="rounded-md border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
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

function TaskDetailPane({
  assigneeOptions,
  collaboration,
  currentWorkspaceMemberKey,
  detail,
  errorMessage,
  isLoading,
  locale,
  onUpdateIssue,
  projects,
  t,
  task,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  collaboration?: IssueCollaborationController
  currentWorkspaceMemberKey?: string
  detail?: TeamIssueDetail
  errorMessage?: string
  isLoading: boolean
  locale: Locale
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
  task?: ProjectTask
  workspaceMembers: WorkspaceMember[]
}) {
  if (!task) {
    return (
      <aside
        className="workbench-detail-pane min-h-0 min-w-0 px-5 py-6 max-[1180px]:border-l-0 max-[1180px]:border-t"
        data-testid="task-detail-pane"
      >
        <p className="rounded-md border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.detail.empty')}
        </p>
      </aside>
    )
  }

  const issue = detail?.issue
  const needsDetailBeforeEdit = task.source === 'dynamodb' && !issue
  const isReadOnly = !onUpdateIssue || !task.teamId || task.source !== 'dynamodb' || needsDetailBeforeEdit
  const title = issue ? resolveTeamIssueTitle(issue, t) : resolveTaskTitle(task, t)
  const assigneeUserId = issue?.assigneeUserId ?? task.assigneeUserId ?? ''
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === assigneeUserId)
  const assigneeLabel = issue ? resolveTeamIssueAssignee(issue) : resolveTaskAssignee(task, t)
  const dueDate = issue?.dueDate ?? task.dueDate
  const assignedProjectId = issue?.assignedProjectId ?? task.projectId ?? ''

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1180px]:border-l-0 max-[1180px]:border-t"
      data-testid="task-detail-pane"
    >
      <form
        className="grid min-w-0 gap-4 border-b border-[var(--workbench-border)] bg-white px-5 py-4"
        key={`${task.teamId ?? ''}:${task.id}:${issue?.updatedAt ?? 'loading'}`}
        onSubmit={(event) => {
          event.preventDefault()

          if (isReadOnly || !task.teamId) {
            return
          }

          const formData = new FormData(event.currentTarget)
          const nextAssignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: nextAssignedProjectId || null,
            description: String(formData.get('description') ?? '').trim(),
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
            priority: resolveTaskPriority(formData.get('priority')),
            status: resolveTaskStatus(formData.get('status')),
            title: String(formData.get('title') ?? '').trim(),
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(task.teamId, task.id, nextIssueInput)
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow text-[var(--workbench-muted)]">
              {t('tasks.detail.title')}
            </p>
            <h2 className="mt-1.5 text-lg font-semibold leading-6 text-[var(--workbench-text)]">{title}</h2>
            {isLoading ? (
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('tasks.detail.loading')}</p>
            ) : null}
          </div>
          <TaskPriorityBadge priority={issue?.priority ?? task.priority} t={t} />
        </div>
        <fieldset className="contents" disabled={isReadOnly}>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.column.title')}
            <input
              className="workbench-input w-full min-w-0 px-3 py-2 text-base font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
              defaultValue={title}
              name="title"
              required
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.detail.description')}
            <textarea
              className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
              defaultValue={issue?.description ?? ''}
              name="description"
            />
          </label>
          <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.project')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={assignedProjectId}
                name="assignedProjectId"
              >
                <option value="">{t('issues.project.unassigned')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.assignee')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={assigneeUserId}
                name="assigneeUserId"
              >
                {!hasSelectedAssigneeOption && assigneeUserId ? (
                  <option value={assigneeUserId}>{assigneeLabel}</option>
                ) : null}
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={issue?.status ?? task.status}
                name="status"
              >
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>{t(`tasks.status.${status}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.priority')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={issue?.priority ?? task.priority}
                name="priority"
              >
                {taskPriorities.map((priority) => (
                  <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.dueDate')}
              <input
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={formatDateInputValue(dueDate)}
                name="dueDate"
                type="date"
              />
            </label>
          </div>
        </fieldset>
        <button
          className="workbench-button-primary h-10 px-4 disabled:border-slate-300 disabled:bg-slate-300"
          disabled={isReadOnly}
          type="submit"
        >
          {t('issues.detail.save')}
        </button>
        {isReadOnly && !needsDetailBeforeEdit ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t(!onUpdateIssue ? 'tasks.detail.readOnlyPermission' : 'tasks.detail.readOnly')}
          </p>
        ) : null}
        {errorMessage ? <p className="text-sm font-semibold text-red-700">{errorMessage}</p> : null}
      </form>
      {collaboration ? (
        <IssueCollaborationPanel
          key={`${task.teamId ?? ''}:${task.id}`}
          controller={collaboration}
          currentMemberKey={currentWorkspaceMemberKey}
          locale={locale}
          members={workspaceMembers}
          readOnlyMessage={task.source === 'legacy' ? t('tasks.comment.readOnly') : undefined}
        />
      ) : null}
    </aside>
  )
}

function TaskGantt({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const sortedTasks = [...tasks].sort((firstTask, secondTask) =>
    firstTask.dueDate.localeCompare(secondTask.dueDate),
  )

  return (
    <section
      aria-label={t(viewLabelKeys.gantt)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading count={tasks.length} t={t} titleKey={viewLabelKeys.gantt} />
      <div className="grid grid-cols-[240px_1fr] border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] text-xs font-semibold text-[var(--workbench-muted)] max-[820px]:grid-cols-[210px_1fr]">
        <div className="px-4 py-3">{t('tasks.gantt.owner')}</div>
        <div className="grid grid-cols-4 px-4 py-3">
          <span>{t('tasks.gantt.phase.discovery')}</span>
          <span>{t('tasks.gantt.phase.build')}</span>
          <span>{t('tasks.gantt.phase.review')}</span>
          <span>{t('tasks.gantt.phase.release')}</span>
        </div>
      </div>
      <div className="divide-y divide-[#e4e7ec]">
        {sortedTasks.map((task, index) => (
          <div className="grid grid-cols-[240px_1fr] items-center max-[820px]:grid-cols-[210px_1fr]" key={createTaskKey(task)}>
            <div className="min-w-0 px-4 py-3">
              <p className="truncate text-sm font-semibold text-[#1c1d1f]">{resolveTaskTitle(task, t)}</p>
              <p className="mt-1 text-xs font-medium text-[#5f6874]">{resolveTaskAssignee(task, t)}</p>
            </div>
            <div className="px-4 py-3">
              <div className="relative h-9 rounded-md bg-[var(--workbench-surface-muted)]">
                <div
                  className="absolute top-2 h-5 rounded-md bg-[var(--workbench-primary)]"
                  style={{
                    left: `${Math.min(index * 14, 58)}%`,
                    width: `${task.priority === 'high' ? 38 : task.priority === 'medium' ? 32 : 24}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs font-semibold text-[#5f6874]">
                {t('tasks.gantt.window').replace('{date}', task.dueDate)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function TaskCalendar({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const taskCalendarDays = createTaskCalendarDays(tasks)

  return (
    <section
      aria-label={t(viewLabelKeys.calendar)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey={viewLabelKeys.calendar}
      />
      <div className="grid grid-cols-6 max-[1180px]:grid-cols-3 max-[720px]:grid-cols-1">
        {taskCalendarDays.map((day) => {
          const dayTasks = tasks.filter((task) => task.dueDate === day.date)

          return (
            <div className="min-h-[230px] border-r border-[#e4e7ec] p-3 last:border-r-0" key={`${day.id}-${day.date}`}>
              <p className="text-sm font-semibold text-[#1c1d1f]">{day.label}</p>
              <p className="mt-1 text-xs font-medium text-[#5f6874]">{day.date}</p>
              <div className="mt-3 grid gap-2">
                {dayTasks.length > 0 ? (
                  dayTasks.map((task) => (
                    <article className="rounded-md border border-[#99d7cf] bg-[#e5f7f4] p-3" key={createTaskKey(task)}>
                      <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                      <p className="mt-2 text-xs font-medium text-[var(--workbench-primary)]">{resolveTaskAssignee(task, t)}</p>
                    </article>
                  ))
                ) : (
                  <p className="rounded-md border border-dashed border-[#d3d8df] px-3 py-5 text-sm font-medium text-[#5f6874]">
                    {t('tasks.calendar.empty')}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TaskFileList({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  return (
    <section
      aria-label={t(viewLabelKeys.file)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.file.description')}
        t={t}
        titleKey={viewLabelKeys.file}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.name')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.owner')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.column.dueDate')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr className="border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0" key={createTaskKey(task)}>
                <td className="px-4 py-3 font-semibold">{resolveTaskTitle(task, t)}</td>
                <td className="px-4 py-3 text-[#505967]">{resolveTaskAssignee(task, t)}</td>
                <td className="px-4 py-3 text-[#5f6874]">{task.dueDate}</td>
                <td className="px-4 py-3">
                  <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                    {t(`tasks.status.${task.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ViewHeading({
  className = '',
  count,
  meta,
  t,
  titleKey,
}: {
  className?: string
  count: number
  meta?: string
  t: (key: MessageKey) => string
  titleKey: MessageKey
}) {
  return (
    <div className={`border-b border-[#e4e7ec] bg-white px-4 py-3 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[#1c1d1f]">{t(titleKey)}</h2>
        <p className="text-sm font-medium text-[#5f6874]">
          {t('tasks.count').replace('{count}', String(count))}
        </p>
      </div>
      {meta ? <p className="mt-1 text-sm font-medium text-[#5f6874]">{meta}</p> : null}
    </div>
  )
}

function TaskStatusBadge({ status, t }: { status: TaskStatus; t: (key: MessageKey) => string }) {
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

function TaskPriorityBadge({
  priority,
  t,
}: {
  priority: TaskPriority
  t: (key: MessageKey) => string
}) {
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
      accentClassName: 'bg-[var(--workbench-primary)]',
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
      className="flex min-w-[390px] items-center gap-3 border-l border-[#e4e7ec] py-2 pl-4 max-[1280px]:hidden"
    >
      {projectMetrics.map((metric) => (
        <div className="min-w-[96px]" key={metric.labelKey}>
          <p className="text-xs font-semibold text-[#5f6874]">{t(metric.labelKey)}</p>
          <p className="mt-1 text-lg font-semibold leading-none text-[#1c1d1f]">{metric.value}</p>
          <div className="mt-2 h-1 rounded-full bg-[#e4e7ec]">
            <div
              className={`h-1 rounded-full ${metric.accentClassName}`}
              style={{ width: `${metric.progressPercent}%` }}
            />
          </div>
        </div>
      ))}
      <div>
        <p className="text-xs font-semibold text-[#5f6874]">{t('tasks.metric.completionRate')}</p>
        <p className="mt-1 text-lg font-semibold leading-none text-[#1c1d1f]">{completionRate}%</p>
      </div>
      <div className="relative h-10 w-10">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(var(--workbench-primary) 0 ${completionRate}%, var(--workbench-border) ${completionRate}% 100%)`,
          }}
        />
        <div className="absolute inset-[6px] rounded-full bg-white" />
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
      className={`inline-flex h-9 min-w-[104px] items-center justify-between gap-2 rounded-md border bg-white px-3 text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
        active
          ? 'border-[var(--workbench-primary)] text-[var(--workbench-primary)]'
          : 'border-[var(--workbench-border-strong)] text-[var(--workbench-text)] hover:border-[var(--workbench-primary)] hover:text-[var(--workbench-primary)]'
      }`}
      id={id}
      onClick={onClick}
      type="button"
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <ChevronIcon className="h-4 w-4" />
    </button>
  )
}

function TaskRow({
  rowIndex,
  selected,
  selectedForDetail,
  onSelectTask,
  onTaskSelectionChange,
  task,
  t,
}: {
  rowIndex: number
  selected: boolean
  selectedForDetail: boolean
  onSelectTask: (task: ProjectTask) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  task: ProjectTask
  t: (key: MessageKey) => string
}) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'workbench-badge-primary',
    review: 'workbench-badge-warning',
    todo: 'workbench-badge',
    done: 'workbench-badge-success',
  }
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'workbench-badge-danger',
    medium: 'workbench-badge-warning',
    low: 'workbench-badge-success',
  }
  const taskTitle = resolveTaskTitle(task, t)
  const isOverdue = isTaskOverdue(task)

  return (
    <tr
      className={`border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0 ${
        selectedForDetail ? 'workbench-row-selected' : 'hover:bg-[var(--workbench-surface-muted)]'
      }`}
      data-row-index={rowIndex}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`task-row-${task.id}`}
    >
      <td className="px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <input
            aria-label={taskTitle}
            checked={selected}
            className="h-4 w-4 rounded border-[var(--workbench-border-strong)] text-[var(--workbench-primary)]"
            onChange={(event) => onTaskSelectionChange(task.id, event.target.checked)}
            type="checkbox"
          />
          <button
            className="min-w-0 truncate text-left font-semibold text-[var(--workbench-text)] transition hover:text-[var(--workbench-primary)]"
            onClick={() => onSelectTask(task)}
            type="button"
          >
            {taskTitle}
          </button>
          {selected ? (
            <span className="workbench-badge-primary">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="truncate px-3 py-2.5 text-[#505967]">{resolveTaskAssignee(task, t)}</td>
      <td className="px-3 py-2.5">
        <span className={statusClasses[task.status]}>
          {t(`tasks.status.${task.status}`)}
        </span>
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 ${
          task.status === 'done' ? 'text-[#8f99a8] line-through' : isOverdue ? 'text-red-700' : 'text-[#505967]'
        }`}
      >
        {task.dueDate}
      </td>
      <td className="px-3 py-2.5">
        <span
          className={`${priorityClasses[task.priority]} whitespace-nowrap`}
        >
          <FlagIcon className="h-4 w-4" />
          {t(`tasks.priority.${task.priority}`)}
        </span>
      </td>
      <td className="px-3 py-2.5" />
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

function createAssigneeFilterOptions(
  tasks: ProjectTask[],
  t: (key: MessageKey) => string,
): AssigneeFilterOption[] {
  const assigneeOptionsByValue = new Map<string, AssigneeFilterOption>()

  for (const task of tasks) {
    const value = resolveTaskAssigneeFilterValue(task, t)

    if (!value || assigneeOptionsByValue.has(value)) {
      continue
    }

    assigneeOptionsByValue.set(value, {
      label: resolveTaskAssignee(task, t) || t('tasks.detail.unassigned'),
      value,
    })
  }

  return [
    {
      label: t('tasks.filter.assigneeAll'),
      value: 'all',
    },
    ...Array.from(assigneeOptionsByValue.values()).sort((firstOption, secondOption) =>
      firstOption.label.localeCompare(secondOption.label),
    ),
  ]
}

function resolveTaskAssigneeFilterValue(
  task: ProjectTask,
  t: (key: MessageKey) => string,
) {
  return task.assigneeUserId ??
    task.assigneeEmail ??
    resolveTaskAssignee(task, t) ??
    t('tasks.detail.unassigned')
}

function matchesTaskDueDateFilter(task: ProjectTask, filter: DueDateFilter) {
  if (filter === 'all') {
    return true
  }

  const dueDate = parseTaskDueDate(task.dueDate)

  if (filter === 'no-date') {
    return !dueDate
  }

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (filter === 'overdue') {
    return dueDate < today
  }

  return dueDate >= today
}

function sortTasksByDueDate(tasks: ProjectTask[], sortOrder: TaskSortOrder) {
  return [...tasks].sort((firstTask, secondTask) => {
    const firstTime = parseTaskDueDate(firstTask.dueDate)?.getTime()
    const secondTime = parseTaskDueDate(secondTask.dueDate)?.getTime()
    const firstSortTime = firstTime ?? Number.MAX_SAFE_INTEGER
    const secondSortTime = secondTime ?? Number.MAX_SAFE_INTEGER

    if (firstSortTime === secondSortTime) {
      return firstTask.id.localeCompare(secondTask.id)
    }

    if (sortOrder === 'due-date-desc') {
      return secondSortTime - firstSortTime
    }

    return firstSortTime - secondSortTime
  })
}

function resolveDueDateFilterLabelKey(filter: DueDateFilter): MessageKey {
  const labelKeys: Record<DueDateFilter, MessageKey> = {
    all: 'tasks.filter.dueDateAll',
    overdue: 'tasks.filter.dueDateOverdue',
    upcoming: 'tasks.filter.dueDateUpcoming',
    'no-date': 'tasks.filter.dueDateNoDate',
  }

  return labelKeys[filter]
}

function resolveTaskSortOrderLabelKey(sortOrder: TaskSortOrder): MessageKey {
  return sortOrder === 'due-date-desc'
    ? 'tasks.sort.dueDateDesc'
    : 'tasks.sort.dueDateAsc'
}

function formatDateInputValue(value: string) {
  return value.replaceAll('/', '-')
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

function resolveTeamIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  return issue.title ?? (issue.titleKey ? t(issue.titleKey) : issue.id)
}

function resolveTeamIssueAssignee(issue: TeamIssue) {
  return issue.assigneeName ?? issue.assigneeEmail ?? issue.assigneeUserId
}

function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

function createTaskKey(task: ProjectTask) {
  return task.projectId || task.teamId
    ? `${task.projectId ?? ''}:${task.teamId ?? ''}:${task.id}`
    : task.id
}

function createTaskCalendarDays(tasks: ProjectTask[]) {
  const dates = Array.from(new Set(tasks.map((task) => task.dueDate)))
    .filter(Boolean)
    .sort()
    .slice(0, 6)
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '/')

  if (dates.length === 0) {
    return [
      {
        id: 'empty',
        label: today,
        date: today,
      },
    ]
  }

  return dates.map((date) => ({
    id: date,
    label: date,
    date,
  }))
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
      className={`grid h-9 w-9 place-items-center text-[#505967] transition hover:bg-[#f3f4f6] hover:text-[#1c1d1f] focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
        rounded ? 'rounded-full' : 'rounded-md'
      }`}
      type="button"
    >
      {children}
    </button>
  )
}

function ProjectGlyph() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded border border-[#d3d8df] bg-[#f3f4f6] text-app-micro font-semibold text-[#505967]">
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
    permissions: 'P',
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-5 w-5 place-items-center rounded border border-[#d3d8df] bg-white text-[0.65rem] font-semibold text-[#505967]"
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
