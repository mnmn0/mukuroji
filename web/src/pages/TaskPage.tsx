import type {
  CustomFieldDefinition,
  CustomFieldValue,
  ResolvedWorkItemConfiguration,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
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
import { IssueArtifactsPanel } from '../files/IssueArtifactsPanel'
import { ProjectFilesPanel } from '../files/ProjectFilesPanel'
import {
  type FileArtifactScope,
  type FileArtifactsController,
  useFileArtifacts,
} from '../files/useFileArtifacts'
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
  getTeamIssues,
  getProjectIssues,
  TeamIssuesApiError,
  type TeamIssue,
  type TeamIssueDetail,
  type UpdateTeamIssueInput,
  updateTeamIssue,
} from '../issues/api'
import { IssueCollaborationPanel } from '../issues/IssueCollaborationPanel'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../issues/workItemDisplay'
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
import { useWorkspaceCommandMenu } from '../commands/WorkspaceCommandMenuContext'
import {
  createWorkItemRelation,
  deleteWorkItemRelation,
  getWorkItemConfiguration,
  WorkItemConfigurationApiError,
} from '../work-items/api'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
  sortCustomFieldDefinitions,
  type CustomFieldValidationError,
} from '../work-items/customFields'
import {
  WorkItemFieldsEditor,
  type WorkItemPersonOption,
} from '../work-items/WorkItemFieldsEditor'
import {
  WorkItemDefinitionFilters,
} from '../work-items/WorkItemDefinitionFilters'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../work-items/workItemFilters'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../work-items/WorkItemRelationsEditor'
import {
  formatWorkItemCustomFieldValue,
  resolveAllowedWorkflowStatuses,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
  resolveWorkflowStatusDefinition,
  resolveWorkflowStatusLabel,
  sortWorkflowStatuses,
} from '../work-items/workItemDisplay'

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
type StatusFilter = string | 'all'

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
   * Team / Workspace から解決した workflow と custom field configuration です。
   */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /**
   * Work Item configuration の取得失敗時に表示するエラーメッセージです。
   */
  configurationErrorMessage?: string
  /**
   * Relation target として表示できる Team 全体の Issue 候補です。
   */
  relationCandidates?: TeamIssue[]
  /**
   * Relation 候補を取得中かどうかです。
   */
  isRelationCandidatesLoading?: boolean
  /**
   * Relation 候補の取得失敗時に表示するエラーメッセージです。
   */
  relationCandidatesErrorMessage?: string
  /**
   * 選択中 Issue の comment thread、watcher、presence です。
   */
  collaboration?: IssueCollaborationController
  /**
   * 選択中 Work Item の file/version/annotation/approval controller です。
   */
  artifacts?: FileArtifactsController
  /**
   * Project File tab の file controller です。
   */
  projectFiles?: FileArtifactsController
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
   * 選択中 Work Item へ relation を追加する callback です。
   */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /**
   * 選択中 Work Item の relation を解除する callback です。
   */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
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

const taskTabPanelId = 'task-tabpanel'

function createTaskTabId(tab: TaskTab) {
  return `task-tab-${tab}`
}

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
  const tasks = activeTeam
    ? projectIssues.filter((issue) => issue.teamId === activeTeam.id)
    : projectIssues
  const workItemConfigurationKey = accessToken && user && !currentUserError && activeTeam
    ? (['project-work-item-configuration', accessToken, activeTeam.id] as const)
    : null
  const {
    data: resolvedConfiguration,
    error: workItemConfigurationError,
    isLoading: isWorkItemConfigurationLoading,
  } = useSWR(
    workItemConfigurationKey,
    ([, token, teamId]) => getWorkItemConfiguration(token, { kind: 'team', teamId }),
    apiSWRConfig,
  )
  const relationCandidatesKey = accessToken && user && !currentUserError && activeTeam
    ? (['project-relation-candidates', accessToken, activeTeam.id] as const)
    : null
  const {
    data: relationCandidates = emptyTeamIssues,
    error: relationCandidatesError,
    isLoading: isRelationCandidatesLoading,
  } = useSWR(
    relationCandidatesKey,
    ([, token, teamId]) => getTeamIssues(teamId, token),
    apiSWRConfig,
  )
  const resolvedSelectedIssue =
    findIssueBySelection(tasks, selectedIssueId, selectedTeamId) ??
    tasks[0]
  const resolvedSelectedIssueTeamId = resolvedSelectedIssue?.teamId ?? activeTeam?.id
  const collaboration = useIssueCollaboration({
    accessToken,
    enabled: resolvedSelectedIssue?.source !== 'legacy',
    issueId: resolvedSelectedIssue?.id,
    projectId: resolvedSelectedIssue?.assignedProjectId ?? projectId,
    teamId: resolvedSelectedIssueTeamId,
  })
  const artifactIssueId = resolvedSelectedIssue?.id
  const artifactProjectTeamId = activeTeam?.id
  const issueFileScope = useMemo<FileArtifactScope | undefined>(() =>
    artifactIssueId && resolvedSelectedIssueTeamId
      ? {
          kind: 'work-item',
          issueId: artifactIssueId,
          teamId: resolvedSelectedIssueTeamId,
        }
      : undefined,
  [artifactIssueId, resolvedSelectedIssueTeamId])
  const projectFileScope = useMemo<FileArtifactScope | undefined>(() =>
    artifactProjectTeamId
      ? { kind: 'project', projectId, teamId: artifactProjectTeamId }
      : undefined,
  [artifactProjectTeamId, projectId])
  const issueArtifacts = useFileArtifacts({
    accessToken,
    enabled: resolvedSelectedIssue?.source !== 'legacy',
    scope: issueFileScope,
  })
  const projectFiles = useFileArtifacts({ accessToken, scope: projectFileScope })
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
  const configurationErrorMessage = workItemConfigurationError
    ? t('workItems.configuration.loadError')
    : undefined
  const relationCandidatesErrorMessage = relationCandidatesError
    ? t('tasks.detail.error')
    : undefined
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError) ||
    Boolean(user && isProjectTasksLoading) ||
    Boolean(workItemConfigurationKey && isWorkItemConfigurationLoading)

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
      : tasks.find((issue) => issue.id === issueId && issue.teamId === teamId)

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

  const handleAddRelation = async (
    issueId: string,
    input: WorkItemRelationEditorInput,
  ) => {
    const teamId = selectedIssueDetail?.issue.id === issueId
      ? selectedIssueDetail.issue.teamId
      : resolvedSelectedIssueTeamId

    if (!accessToken || !teamId) {
      return
    }

    const graphRevision = readSelectedRelationGraphRevision(selectedIssueDetail, issueId)

    try {
      await mutationRequestRunner.run(
        `issue:relation:create:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, input]),
        (context) => createWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          { ...input, expectedGraphRevision: graphRevision },
          context,
        ),
      )
      await mutateSelectedIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateSelectedIssueDetail)
      throw error
    }
  }

  const handleDeleteRelation = async (
    issueId: string,
    relation: WorkItemRelation,
  ) => {
    const teamId = selectedIssueDetail?.issue.id === issueId
      ? selectedIssueDetail.issue.teamId
      : resolvedSelectedIssueTeamId

    if (!accessToken || !teamId) {
      return
    }

    const graphRevision = readSelectedRelationGraphRevision(selectedIssueDetail, issueId)

    try {
      await mutationRequestRunner.run(
        `issue:relation:delete:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, relation.type, relation.targetWorkItemId]),
        (context) => deleteWorkItemRelation(
          teamId,
          issueId,
          accessToken,
          {
            expectedGraphRevision: graphRevision,
            targetWorkItemId: relation.targetWorkItemId,
            type: relation.type,
          },
          context,
        ),
      )
      await mutateSelectedIssueDetail()
    } catch (error) {
      await refreshRelationDetailAfterConflict(error, mutateSelectedIssueDetail)
      throw error
    }
  }

  return (
    <TaskScreen
      configurationErrorMessage={configurationErrorMessage}
      isLoading={isLoading}
      isRelationCandidatesLoading={Boolean(relationCandidatesKey && isRelationCandidatesLoading)}
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
      onCreateTask={canMutateContent && !workItemConfigurationError ? handleCreateTask : undefined}
      onAddRelation={canMutateContent ? handleAddRelation : undefined}
      assigneeErrorMessage={projectMembersErrorMessage}
      assigneeOptions={activeProjectMembers}
      canManageProjectMembers={canManageProjectMembers}
      collaboration={collaboration}
      artifacts={resolvedSelectedIssue?.source !== 'legacy' ? issueArtifacts : undefined}
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
      onDeleteRelation={canMutateContent ? handleDeleteRelation : undefined}
      onSelectedIssueChange={handleSelectedIssueChange}
      onUpdateIssue={canMutateContent && !workItemConfigurationError ? handleUpdateIssue : undefined}
      onUpdateProjectMember={canManageProjectMembers ? handleUpdateProjectMember : undefined}
      projectId={projectId}
      projectFiles={projectFiles}
      projectMembers={projectMembers}
      projectMembersErrorMessage={projectPermissionsErrorMessage}
      projectName={projectName}
      projectUserQuery={projectUserQuery}
      projectUsers={projectUsers}
      projectUsersErrorMessage={projectUsersErrorMessage}
      projectUsersNextToken={projectUsersNextToken}
      relationCandidates={relationCandidates}
      relationCandidatesErrorMessage={relationCandidatesErrorMessage}
      selectedIssueDetail={selectedIssueDetail}
      resolvedConfiguration={resolvedConfiguration ?? selectedIssueDetail?.resolvedConfiguration}
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
  artifacts,
  configurationErrorMessage,
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
  isRelationCandidatesLoading = false,
  isSelectedIssueDetailLoading = false,
  isSystemAdmin = false,
  isLoading = false,
  projectMembers = emptyProjectMembers,
  projectFiles,
  projectMembersErrorMessage,
  projectUserQuery = '',
  projectUsers = emptyProjectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  relationCandidates = emptyTeamIssues,
  relationCandidatesErrorMessage,
  resolvedConfiguration,
  selectedIssueDetail,
  tasks = [],
  taskErrorMessage,
  onLoadMoreProjectUsers,
  onAddRelation,
  onDeleteRelation,
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
  const [definitionFilter, setDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
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
  const configuration = resolvedConfiguration?.configuration
  const workflowStatuses = useMemo(
    () => resolveDisplayWorkflowStatuses(tasks, configuration, t),
    [configuration, t, tasks],
  )
  const personLabels = useMemo(
    () => Object.fromEntries(
      workspaceMembers.map((member) => [member.email, member.name ?? member.email]),
    ),
    [workspaceMembers],
  )
  const selectedDetailTaskId = localSelectedDetailTaskId ?? initialSelectedTaskId

  useEffect(() => {
    if (defaultCreateTaskOpen) {
      queueMicrotask(() => setIsCreateTaskOpen(true))
    }
  }, [defaultCreateTaskOpen])

  const visibleTasks = useMemo(
    () => {
      const filteredTasks = tasks.filter((task) => {
        const matchesStatus = statusFilter === 'all' || resolveTaskWorkflowStatusId(task) === statusFilter
        const matchesAssignee = assigneeFilter === 'all' || resolveTaskAssigneeFilterValue(task, t) === assigneeFilter
        const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter
        const matchesDueDate = matchesTaskDueDateFilter(task, dueDateFilter)
        const matchesDefinition = matchesWorkItemDefinitionFilter(
          task,
          configuration,
          definitionFilter,
        )
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (
          !matchesStatus ||
          !matchesAssignee ||
          !matchesPriority ||
          !matchesDueDate ||
          !matchesDefinition
        ) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return [
          resolveTaskTitle(task, t),
          resolveTaskAssignee(task, t),
          resolveTaskWorkflowStatusLabel(task, configuration, t),
          t(`tasks.priority.${task.priority}`),
          task.dueDate,
          ...resolveTaskCustomFieldSearchValues(
            task,
            configuration,
            locale,
            personLabels,
          ),
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      })

      return sortTasksByDueDate(filteredTasks, sortOrder)
    },
    [
      assigneeFilter,
      configuration,
      definitionFilter,
      dueDateFilter,
      locale,
      personLabels,
      priorityFilter,
      searchQuery,
      sortOrder,
      statusFilter,
      t,
      tasks,
    ],
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
          configuration={configuration}
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
            {configurationErrorMessage ? (
              <p
                className="mx-[clamp(20px,3vw,34px)] mt-5 rounded-md border border-red-200 bg-red-50 px-5 py-4 text-sm font-semibold text-red-700"
                role="alert"
              >
                {configurationErrorMessage}
              </p>
            ) : null}
            {isCreateTaskOpen && onCreateTask ? (
              <CreateTaskPanel
                assigneeErrorMessage={assigneeErrorMessage}
                assigneeOptions={assigneeOptions}
                configuration={configuration}
                isAssigneeOptionsLoading={isAssigneeOptionsLoading}
                errorMessage={createTaskError}
                isSubmitting={isCreatingTask}
                locale={locale}
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
                projectId={projectId}
                t={t}
                workspaceMembers={workspaceMembers}
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
                configuration={configuration}
                definitionFilter={definitionFilter}
                dueDateFilter={dueDateFilter}
                isAssigneeMenuOpen={isAssigneeMenuOpen}
                isDueDateMenuOpen={isDueDateMenuOpen}
                isPriorityMenuOpen={isPriorityMenuOpen}
                isSortMenuOpen={isSortMenuOpen}
                isStatusMenuOpen={isStatusMenuOpen}
                isProjectMembersLoading={isAssigneeOptionsLoading}
                isProjectUsersLoading={isProjectUsersLoading}
                isSystemAdmin={isSystemAdmin}
                locale={locale}
                personLabels={personLabels}
                personOptions={resolveWorkItemPersonOptions(workspaceMembers)}
                priorityFilter={priorityFilter}
                projectId={projectId}
                projectFiles={projectFiles}
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
                onDefinitionFilterChange={setDefinitionFilter}
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
                currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                workspaceMembers={workspaceMembers}
                workflowStatuses={workflowStatuses}
              />
              {activeTab === 'permissions' || activeTab === 'file' ? null : (
                <TaskDetailPane
                  assigneeOptions={assigneeOptions}
                  artifacts={artifacts}
                  collaboration={collaboration}
                  configuration={configuration}
                  currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                  detail={selectedIssueDetail}
                  errorMessage={detailErrorMessage}
                  focusedCommentId={focusedCommentId}
                  focusedRootCommentId={focusedRootCommentId}
                  isLoading={isSelectedIssueDetailLoading}
                  isRelationCandidatesLoading={isRelationCandidatesLoading}
                  key={`${selectedDetailTask?.teamId ?? ''}:${selectedDetailTask?.id ?? ''}`}
                  locale={locale}
                  onAddRelation={onAddRelation}
                  onDeleteRelation={onDeleteRelation}
                  projects={activeTeamProjects}
                  relationCandidates={relationCandidates}
                  relationCandidatesErrorMessage={relationCandidatesErrorMessage}
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
  configuration,
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
  configuration?: WorkItemConfiguration
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
  const openTaskCount = tasks.filter((task) => {
    const category = resolveWorkflowStatusCategory(task, configuration)

    return category !== 'completed' && category !== 'canceled'
  }).length
  const reviewTaskCount = tasks.filter(
    (task) => resolveWorkflowStatusCategory(task, configuration) === 'started',
  ).length
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
                {t('tasks.metric.inProgress')}: {reviewTaskCount}
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
        <SummaryCard configuration={configuration} t={t} tasks={tasks} />
      </div>
    </header>
  )
}

function TaskWorkspace({
  activeTab,
  allTasks,
  assigneeFilter,
  canManageProjectMembers,
  configuration,
  definitionFilter,
  dueDateFilter,
  isAssigneeMenuOpen,
  isDueDateMenuOpen,
  isPriorityMenuOpen,
  isSortMenuOpen,
  isStatusMenuOpen,
  isProjectMembersLoading,
  isProjectUsersLoading,
  isSystemAdmin,
  locale,
  personLabels,
  personOptions,
  priorityFilter,
  projectId,
  projectFiles,
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
  onDefinitionFilterChange,
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
  currentWorkspaceMemberKey,
  workspaceMembers,
  workflowStatuses,
}: {
  activeTab: TaskTab
  allTasks: ProjectTask[]
  assigneeFilter: AssigneeFilter
  canManageProjectMembers: boolean
  /** Work Item の表示と集計に使う設定です。 */
  configuration?: WorkItemConfiguration
  /** Workflow category と custom field 値の filter です。 */
  definitionFilter: WorkItemDefinitionFilter
  dueDateFilter: DueDateFilter
  isAssigneeMenuOpen: boolean
  isDueDateMenuOpen: boolean
  isPriorityMenuOpen: boolean
  isSortMenuOpen: boolean
  isStatusMenuOpen: boolean
  isProjectMembersLoading: boolean
  isProjectUsersLoading: boolean
  isSystemAdmin: boolean
  /** Custom field value の表示 locale です。 */
  locale: Locale
  /** Person field ID から表示名を解決する map です。 */
  personLabels: Readonly<Record<string, string>>
  /** Person custom field の filter 候補です。 */
  personOptions: WorkItemPersonOption[]
  priorityFilter: PriorityFilter
  projectId: string
  projectFiles?: FileArtifactsController
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
  /** Workflow category と custom field 値の filter 変更 callback です。 */
  onDefinitionFilterChange: (filter: WorkItemDefinitionFilter) => void
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
  currentWorkspaceMemberKey?: string
  workspaceMembers: WorkspaceMember[]
  /** Filter と board の列に表示する workflow status です。 */
  workflowStatuses: WorkflowStatusDefinition[]
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

  if (activeTab === 'file') {
    return (
      <div className="px-[clamp(18px,2.5vw,30px)] py-4">
        {projectFiles ? (
          <>
            <ViewHeading
              count={projectFiles.files.length}
              meta={t('files.description')}
              t={t}
              titleKey={viewLabelKeys.file}
            />
            <ProjectFilesPanel
              controller={projectFiles}
              currentMemberKey={currentWorkspaceMemberKey}
              locale={locale}
              members={workspaceMembers}
            />
          </>
        ) : (
          <TaskFileList t={t} tasks={tasks} />
        )}
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
              onDefinitionFilterChange({ category: 'all', customFieldId: '' })
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
                {[
                  { id: 'all', name: t('tasks.filter.statusAll') },
                  ...workflowStatuses,
                ].map((status) => (
                  <button
                    aria-checked={statusFilter === status.id}
                    className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition ${
                      statusFilter === status.id
                        ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                        : 'text-[#1c1d1f] hover:bg-[#f3f4f6]'
                    }`}
                    key={status.id}
                    onClick={() => onStatusFilterChange(status.id)}
                    role="menuitemradio"
                    type="button"
                  >
                    {status.name}
                    {statusFilter === status.id ? <CheckIcon /> : null}
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
        </div>
      </div>
      <div className="workbench-toolbar mt-3 px-3 py-2">
        <WorkItemDefinitionFilters
          configuration={configuration}
          idPrefix="project-tasks"
          locale={locale}
          onChange={onDefinitionFilterChange}
          personOptions={personOptions}
          value={definitionFilter}
        />
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
          configuration={configuration}
          locale={locale}
          personLabels={personLabels}
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
          configuration={configuration}
          locale={locale}
          personLabels={personLabels}
          selectedDetailTaskId={selectedDetailTaskId}
          t={t}
          tasks={tasks}
          workflowStatuses={workflowStatuses}
          onSelectTask={onSelectTask}
        />
      ) : null}
      {activeTab === 'gantt' && !taskErrorMessage ? <TaskGantt t={t} tasks={tasks} /> : null}
      {activeTab === 'calendar' && !taskErrorMessage ? <TaskCalendar t={t} tasks={tasks} /> : null}
    </div>
  )
}

function CreateTaskPanel({
  assigneeErrorMessage,
  assigneeOptions,
  configuration,
  errorMessage,
  isAssigneeOptionsLoading,
  isSubmitting,
  locale,
  onCancel,
  onSubmit,
  projectId,
  t,
  workspaceMembers,
}: {
  assigneeErrorMessage?: string
  assigneeOptions: ProjectMember[]
  configuration?: WorkItemConfiguration
  errorMessage?: string
  isAssigneeOptionsLoading: boolean
  isSubmitting: boolean
  locale: Locale
  onCancel: () => void
  onSubmit: (input: CreateProjectTaskInput) => Promise<void>
  projectId: string
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration, t)
  const initialWorkflowStatusId = configuration?.workflow.initialStatusId ?? 'todo'
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(configuration.customFields, projectId)
    : {}
  const hasCustomFields = configuration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, projectId),
  ) ?? false

  return (
    <section className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-[clamp(18px,2.5vw,30px)] py-3">
      <form
        className="workbench-panel grid gap-3 p-4"
        data-testid="create-task-form"
        id="create-task-form"
        onSubmit={(event) => {
          event.preventDefault()

          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? today).replaceAll('-', '/')
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? initialWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const priority = resolveTaskPriority(formData.get('priority'))
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, configuration.customFields, {
                applyDefaults: true,
                projectId,
              })
            : { errors: [], values: {} }

          if (!assigneeUserId) {
            event.currentTarget.reportValidity()
            return
          }

          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              configuration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})

          void onSubmit({
            title,
            assigneeUserId,
            dueDate,
            status: workflowStatus
              ? resolveLegacyStatusForWorkflowStatus(workflowStatus)
              : resolveTaskStatus(null),
            workflowStatusId,
            customFieldValues: parsedCustomFields.values,
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
              defaultValue={initialWorkflowStatusId}
              name="workflowStatusId"
            >
              {workflowStatuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
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
        {hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={configuration?.customFields ?? []}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={projectId}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
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
  configuration,
  locale,
  personLabels,
  selectedDetailTaskId,
  selectedTaskIds,
  onCreateTaskOpen,
  onSelectTask,
  onTaskSelectionChange,
  t,
  taskErrorMessage,
  tasks,
}: {
  configuration?: WorkItemConfiguration
  locale: Locale
  personLabels: Readonly<Record<string, string>>
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
                  <span role="alert">
                    {taskErrorMessage === t('tasks.error.loading')
                      ? taskErrorMessage
                      : `${t('tasks.error.loading')}: ${taskErrorMessage}`}
                  </span>
                </td>
              </tr>
            ) : tasks.length > 0 ? (
              tasks.map((task, index) => (
                <TaskRow
                  configuration={configuration}
                  key={createTaskKey(task)}
                  locale={locale}
                  personLabels={personLabels}
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
  configuration,
  locale,
  personLabels,
  selectedDetailTaskId,
  onSelectTask,
  t,
  tasks,
  workflowStatuses,
}: {
  configuration?: WorkItemConfiguration
  locale: Locale
  personLabels: Readonly<Record<string, string>>
  selectedDetailTaskId?: string
  onSelectTask: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  workflowStatuses: WorkflowStatusDefinition[]
}) {
  return (
    <section
      aria-label={t(viewLabelKeys.board)}
      className="mt-3 grid min-w-0 gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
    >
      <ViewHeading
        className="col-span-full"
        count={tasks.length}
        t={t}
        titleKey={viewLabelKeys.board}
      />
      {workflowStatuses.map((status) => {
        const statusTasks = tasks.filter(
          (task) => resolveTaskWorkflowStatusId(task) === status.id,
        )

        return (
          <div
            className="workbench-panel min-h-[420px]"
            key={status.id}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5">
              <TaskStatusBadge configuration={configuration} status={status} t={t} />
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
                    <TaskCustomFieldSummary
                      configuration={configuration}
                      locale={locale}
                      personLabels={personLabels}
                      task={task}
                    />
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
  artifacts,
  collaboration,
  configuration,
  currentWorkspaceMemberKey,
  detail,
  errorMessage,
  focusedCommentId,
  focusedRootCommentId,
  isLoading,
  isRelationCandidatesLoading,
  locale,
  onAddRelation,
  onDeleteRelation,
  onUpdateIssue,
  projects,
  relationCandidates,
  relationCandidatesErrorMessage,
  t,
  task,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  artifacts?: FileArtifactsController
  collaboration?: IssueCollaborationController
  configuration?: WorkItemConfiguration
  currentWorkspaceMemberKey?: string
  detail?: TeamIssueDetail
  errorMessage?: string
  focusedCommentId?: string
  focusedRootCommentId?: string
  isLoading: boolean
  isRelationCandidatesLoading: boolean
  locale: Locale
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  relationCandidates: TeamIssue[]
  relationCandidatesErrorMessage?: string
  t: (key: MessageKey) => string
  task?: ProjectTask
  workspaceMembers: WorkspaceMember[]
}) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const selectedIssue = task && detail?.issue.id === task.id ? detail.issue : undefined
  const resolvedAssignedProjectId = selectedIssue?.assignedProjectId ?? task?.assignedProjectId ?? ''
  const projectSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [selectedProject, setSelectedProject] = useState({
    identity: projectSelectionIdentity,
    value: resolvedAssignedProjectId,
  })
  const selectedProjectId = selectedProject.identity === projectSelectionIdentity
    ? selectedProject.value
    : resolvedAssignedProjectId

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

  const issue = selectedIssue
  const resolvedConfiguration = detail?.issue.id === task.id
    ? detail.resolvedConfiguration?.configuration ?? configuration
    : configuration
  const needsDetailBeforeEdit = task.source === 'dynamodb' && !issue
  const isReadOnly = !onUpdateIssue || !task.teamId || task.source !== 'dynamodb' || needsDetailBeforeEdit
  const title = issue ? resolveTeamIssueTitle(issue, t) : resolveTaskTitle(task, t)
  const assigneeUserId = issue?.assigneeUserId ?? task.assigneeUserId ?? ''
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === assigneeUserId)
  const assigneeLabel = issue ? resolveWorkItemAssignee(issue, t) : resolveTaskAssignee(task, t)
  const dueDate = issue?.dueDate ?? task.dueDate
  const currentWorkflowStatusId = resolveTaskWorkflowStatusId(issue ?? task)
  const workflowStatuses = resolveEditableWorkflowStatuses(issue ?? task, resolvedConfiguration, t)
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const hasCustomFields = resolvedConfiguration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  ) ?? false
  const relations = detail?.issue.id === task.id ? detail.relations ?? [] : []
  const canonicalRelationCandidates = relationCandidates.filter((candidate) =>
    candidate.source === 'dynamodb' && candidate.teamId === task.teamId,
  )

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1180px]:border-l-0 max-[1180px]:border-t"
      data-testid="task-detail-pane"
    >
      <form
        className="grid min-w-0 gap-4 border-b border-[var(--workbench-border)] bg-white px-5 py-4"
        key={`${task.teamId}:${task.id}:${issue?.revision ?? 'loading'}`}
        onSubmit={(event) => {
          event.preventDefault()

          if (isReadOnly || !task.teamId) {
            return
          }

          const formData = new FormData(event.currentTarget)
          const nextAssignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? currentWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const parsedCustomFields = resolvedConfiguration
            ? parseCustomFieldFormData(formData, resolvedConfiguration.customFields, {
                projectId: nextAssignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              resolvedConfiguration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: nextAssignedProjectId || null,
            customFieldValues: createCustomFieldValuePatch(
              resolvedConfiguration?.customFields ?? [],
              issue?.customFieldValues ?? task.customFieldValues,
              parsedCustomFields.values,
              nextAssignedProjectId || undefined,
            ),
            description: String(formData.get('description') ?? '').trim(),
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
            priority: resolveTaskPriority(formData.get('priority')),
            status: workflowStatus
              ? resolveLegacyStatusForWorkflowStatus(workflowStatus)
              : issue?.status ?? task.status,
            title: String(formData.get('title') ?? '').trim(),
            workflowStatusId,
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(task.teamId, task.id, nextIssueInput).catch(() => undefined)
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
                name="assignedProjectId"
                onChange={(event) => setSelectedProject({
                  identity: projectSelectionIdentity,
                  value: event.target.value,
                })}
                value={selectedProjectId}
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
                defaultValue={currentWorkflowStatusId}
                name="workflowStatusId"
              >
                {workflowStatuses.map((status) => (
                  <option key={status.id} value={status.id}>{status.name}</option>
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
          {hasCustomFields ? (
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={resolvedConfiguration?.customFields ?? []}
                errors={fieldErrors}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue?.customFieldValues ?? task.customFieldValues}
              />
            </div>
          ) : null}
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
      {artifacts ? (
        <IssueArtifactsPanel
          controller={artifacts}
          currentMemberKey={currentWorkspaceMemberKey}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
      <div className="border-b border-[var(--workbench-border)] bg-white px-5 py-5">
        <WorkItemRelationsEditor
          candidates={canonicalRelationCandidates.map((candidate) => ({
            id: candidate.id,
            title: resolveTeamIssueTitle(candidate, t),
          }))}
          currentWorkItemId={task.id}
          errorMessage={relationCandidatesErrorMessage}
          isLoading={isRelationCandidatesLoading || (isLoading && !issue)}
          locale={locale}
          onAddRelation={onAddRelation
            ? (input) => onAddRelation(task.id, input)
            : undefined}
          onDeleteRelation={onDeleteRelation
            ? (relation) => onDeleteRelation(task.id, relation)
            : undefined}
          readOnly={isReadOnly || (!onAddRelation && !onDeleteRelation)}
          relations={relations}
        />
      </div>
      {collaboration ? (
        <IssueCollaborationPanel
          artifacts={artifacts}
          key={`${task.teamId ?? ''}:${task.id}`}
          controller={collaboration}
          currentMemberKey={currentWorkspaceMemberKey}
          focusedCommentId={focusedCommentId}
          focusedRootCommentId={focusedRootCommentId}
          locale={locale}
          members={workspaceMembers}
          readOnlyMessage={task.source === 'legacy' ? t('tasks.comment.readOnly') : undefined}
        />
      ) : null}
    </aside>
  )
}

function TaskGantt({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const sortedTasks = sortTasksByDueDate(tasks, 'due-date-asc')

  return (
    <section
      aria-label={t(viewLabelKeys.gantt)}
      className="workbench-table mt-3 overflow-hidden"
    >
      <ViewHeading
        count={tasks.length}
        meta={t('tasks.calendar.weekTitle')}
        t={t}
        titleKey={viewLabelKeys.gantt}
      />
      {sortedTasks.length > 0 ? (
        <div className="divide-y divide-[#e4e7ec]">
          {sortedTasks.map((task) => (
            <article
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 max-[640px]:grid-cols-1"
              key={createTaskKey(task)}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[#1c1d1f]">
                  {resolveTaskTitle(task, t)}
                </p>
                <p className="mt-1 text-xs font-medium text-[#5f6874]">
                  {resolveTaskAssignee(task, t)}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 max-[640px]:justify-start">
                <TaskStatusBadge task={task} t={t} />
                <span className="text-xs font-semibold text-[#5f6874]">
                  {task.dueDate
                    ? t('tasks.gantt.window').replace('{date}', task.dueDate)
                    : t('tasks.calendar.empty')}
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.empty')}
        </p>
      )}
    </section>
  )
}

function TaskCalendar({ t, tasks }: { t: (key: MessageKey) => string; tasks: ProjectTask[] }) {
  const taskCalendarDays = createTaskCalendarDays(tasks)
  const unscheduledTasks = tasks.filter((task) => !task.dueDate.trim())

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
      {tasks.length > 0 ? (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))' }}
        >
          {taskCalendarDays.map((day) => {
            const dayTasks = tasks.filter((task) => task.dueDate === day.date)

            return (
              <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3" key={day.id}>
                <p className="text-sm font-semibold text-[#1c1d1f]">{day.label}</p>
                <div className="mt-3 grid gap-2">
                  {dayTasks.map((task) => (
                    <article className="rounded-md border border-[#99d7cf] bg-[#e5f7f4] p-3" key={createTaskKey(task)}>
                      <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                      <p className="mt-2 text-xs font-medium text-[var(--workbench-primary)]">{resolveTaskAssignee(task, t)}</p>
                    </article>
                  ))}
                </div>
              </div>
            )
          })}
          {unscheduledTasks.length > 0 ? (
            <div className="min-h-[190px] border-b border-r border-[#e4e7ec] p-3">
              <p className="text-sm font-semibold text-[#1c1d1f]">{t('tasks.calendar.empty')}</p>
              <div className="mt-3 grid gap-2">
                {unscheduledTasks.map((task) => (
                  <article className="rounded-md border border-[var(--workbench-border)] bg-white p-3" key={createTaskKey(task)}>
                    <p className="text-sm font-semibold leading-5 text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                    <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">{resolveTaskAssignee(task, t)}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.empty')}
        </p>
      )}
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

function TaskStatusBadge({
  configuration,
  status,
  task,
  t,
}: {
  /** Status definition の解決に使う configuration です。 */
  configuration?: WorkItemConfiguration
  /** Board column で直接表示する status definition です。 */
  status?: WorkflowStatusDefinition
  /** 一覧で status を表示する Work Item です。 */
  task?: ProjectTask
  /** i18n translator です。 */
  t: (key: MessageKey) => string
}) {
  const resolvedStatus = status ?? (task
    ? resolveWorkflowStatusDefinition(task, configuration)
    : undefined)
  const category = resolvedStatus?.category ?? (task
    ? resolveWorkflowStatusCategory(task, configuration)
    : 'backlog')
  const label = resolvedStatus?.name ?? (task
    ? resolveTaskWorkflowStatusLabel(task, configuration, t)
    : '')

  return (
    <span className={resolveWorkflowCategoryToneClassName(category)}>
      {label}
    </span>
  )
}

function TaskCustomFieldSummary({
  configuration,
  locale,
  personLabels,
  task,
}: {
  /** Custom field definition を含む configuration です。 */
  configuration?: WorkItemConfiguration
  /** 値の format locale です。 */
  locale: Locale
  /** Person field ID を表示名へ解決する map です。 */
  personLabels: Readonly<Record<string, string>>
  /** 表示対象 Work Item です。 */
  task: ProjectTask
}) {
  const values = resolveTaskCustomFieldEntries(task, configuration, locale, personLabels)

  if (values.length === 0) {
    return null
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {values.slice(0, 2).map(({ definition, value }) => (
        <span
          className="workbench-badge max-w-full truncate"
          key={definition.id}
          title={`${definition.name}: ${value}`}
        >
          {definition.name}: {value}
        </span>
      ))}
      {values.length > 2 ? <span className="workbench-badge">+{values.length - 2}</span> : null}
    </div>
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

function SummaryCard({
  configuration,
  t,
  tasks,
}: {
  /** Workflow category の集計に使う configuration です。 */
  configuration?: WorkItemConfiguration
  /** i18n translator です。 */
  t: (key: MessageKey) => string
  /** 集計対象 Work Item です。 */
  tasks: ProjectTask[]
}) {
  const totalCount = tasks.length
  const doneCount = tasks.filter(
    (task) => resolveWorkflowStatusCategory(task, configuration) === 'completed',
  ).length
  const inProgressCount = tasks.filter(
    (task) => resolveWorkflowStatusCategory(task, configuration) === 'started',
  ).length
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
      className="flex min-w-[390px] items-center gap-3 border-l border-[#e4e7ec] py-2 pl-4 max-[1400px]:hidden"
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
  configuration,
  locale,
  personLabels,
  rowIndex,
  selected,
  selectedForDetail,
  onSelectTask,
  onTaskSelectionChange,
  task,
  t,
}: {
  configuration?: WorkItemConfiguration
  locale: Locale
  personLabels: Readonly<Record<string, string>>
  rowIndex: number
  selected: boolean
  selectedForDetail: boolean
  onSelectTask: (task: ProjectTask) => void
  onTaskSelectionChange: (taskId: string, selected: boolean) => void
  task: ProjectTask
  t: (key: MessageKey) => string
}) {
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
          <TaskCustomFieldSummary
            configuration={configuration}
            locale={locale}
            personLabels={personLabels}
            task={task}
          />
          {selected ? (
            <span className="workbench-badge-primary">
              {t('tasks.row.selected')}
            </span>
          ) : null}
        </div>
      </td>
      <td className="truncate px-3 py-2.5 text-[#505967]">{resolveTaskAssignee(task, t)}</td>
      <td className="px-3 py-2.5">
        <TaskStatusBadge configuration={configuration} task={task} t={t} />
      </td>
      <td
        className={`whitespace-nowrap px-3 py-2.5 ${
          resolveWorkflowStatusCategory(task, configuration) === 'completed'
            ? 'text-[#8f99a8] line-through'
            : isOverdue ? 'text-red-700' : 'text-[#505967]'
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
  return resolveWorkItemTitle(task, t)
}

function resolveTaskAssignee(task: ProjectTask, t: (key: MessageKey) => string) {
  return resolveWorkItemAssignee(task, t)
}

function resolveTeamIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  return resolveWorkItemTitle(issue, t)
}

function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

function resolveTaskWorkflowStatusId(task: ProjectTask) {
  return task.workflowStatusId ?? task.status
}

function resolveTaskWorkflowStatusLabel(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
) {
  return resolveWorkflowStatusLabel(
    task,
    configuration,
    (status) => t(`tasks.status.${status}`),
  )
}

function resolveDisplayWorkflowStatuses(
  tasks: readonly ProjectTask[],
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
) {
  const statuses = resolveCreateWorkflowStatuses(configuration, t)
  const knownStatusIds = new Set(statuses.map((status) => status.id))
  const unknownStatuses = tasks.flatMap((task, index) => {
    const statusId = resolveTaskWorkflowStatusId(task)

    if (knownStatusIds.has(statusId)) {
      return []
    }

    knownStatusIds.add(statusId)
    return [{
      id: statusId,
      name: resolveTaskWorkflowStatusLabel(task, configuration, t),
      category: resolveWorkflowStatusCategory(task, configuration),
      sortOrder: statuses.length + index,
    } satisfies WorkflowStatusDefinition]
  })

  return [...statuses, ...unknownStatuses]
}

function resolveCreateWorkflowStatuses(
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
) {
  if (configuration?.workflow.statuses.length) {
    return sortWorkflowStatuses(configuration.workflow.statuses)
  }

  return taskStatuses.map((status, index) => ({
    id: status,
    name: t(`tasks.status.${status}`),
    category: resolveWorkflowStatusCategory({ status }, undefined),
    sortOrder: index,
  }))
}

function resolveEditableWorkflowStatuses(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  t: (key: MessageKey) => string,
) {
  if (!configuration) {
    return resolveCreateWorkflowStatuses(undefined, t)
  }

  const currentStatusId = resolveTaskWorkflowStatusId(task)
  const allowedStatuses = resolveAllowedWorkflowStatuses(currentStatusId, configuration)

  if (allowedStatuses.length > 0) {
    return allowedStatuses
  }

  return [{
    id: currentStatusId,
    name: resolveTaskWorkflowStatusLabel(task, configuration, t),
    category: resolveWorkflowStatusCategory(task, configuration),
    sortOrder: -1,
  } satisfies WorkflowStatusDefinition]
}

function resolveLegacyStatusForWorkflowStatus(status: WorkflowStatusDefinition): TaskStatus {
  if (status.id === 'review') {
    return 'review'
  }
  if (status.category === 'completed' || status.category === 'canceled') {
    return 'done'
  }
  if (status.category === 'started') {
    return 'in-progress'
  }

  return 'todo'
}

function resolveTaskCustomFieldEntries(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  if (!configuration) {
    return []
  }

  const t = createTranslator(locale)

  return sortCustomFieldDefinitions(configuration.customFields).flatMap((definition) => {
    const value = task.customFieldValues?.[definition.id]

    if (value === undefined || !isCustomFieldApplicable(definition, task.assignedProjectId)) {
      return []
    }

    return [{
      definition,
      value: formatWorkItemCustomFieldValue(task, definition, {
        durationUnitLabels: {
          days: t('workItems.durationUnit.days'),
          hours: t('workItems.durationUnit.hours'),
          minutes: t('workItems.durationUnit.minutes'),
        },
        falseLabel: t('workItems.fields.booleanFalse'),
        locale,
        personLabels,
        trueLabel: t('workItems.fields.booleanTrue'),
      }),
    }]
  })
}

function resolveTaskCustomFieldSearchValues(
  task: ProjectTask,
  configuration: WorkItemConfiguration | undefined,
  locale: Locale,
  personLabels: Readonly<Record<string, string>>,
) {
  return resolveTaskCustomFieldEntries(task, configuration, locale, personLabels)
    .flatMap(({ definition, value }) => [definition.name, value])
}

function resolveWorkItemPersonOptions(
  workspaceMembers: readonly WorkspaceMember[],
): WorkItemPersonOption[] {
  return workspaceMembers
    .filter((member) => member.status === 'active')
    .map((member) => ({
      email: member.email,
      id: member.email,
      name: member.name ?? member.email,
    }))
}

function createCustomFieldErrorMessages(
  errors: readonly CustomFieldValidationError[],
  definitions: readonly CustomFieldDefinition[],
  locale: Locale,
) {
  const messages = locale === 'ja'
    ? {
        required: '入力が必要です。',
        'invalid-type': '値の形式が正しくありません。',
        'invalid-option': '定義済みの選択肢を選んでください。',
        'invalid-date': '有効な日付を入力してください。',
        min: '最小値以上で入力してください。',
        max: '最大値以下で入力してください。',
        'min-length': '必要な文字数または件数に達していません。',
        'max-length': '文字数または件数が上限を超えています。',
        pattern: '指定された形式で入力してください。',
      }
    : {
        required: 'A value is required.',
        'invalid-type': 'Enter a value in the expected format.',
        'invalid-option': 'Choose a configured option.',
        'invalid-date': 'Enter a valid date.',
        min: 'Enter a value at or above the minimum.',
        max: 'Enter a value at or below the maximum.',
        'min-length': 'Enter the required number of characters or items.',
        'max-length': 'The character or item limit was exceeded.',
        pattern: 'Enter a value in the configured format.',
      }
  const definitionIds = new Set(definitions.map((definition) => definition.id))
  const result: Record<string, string> = {}

  for (const error of errors) {
    if (!definitionIds.has(error.fieldId)) {
      continue
    }

    result[error.fieldId] = result[error.fieldId]
      ? `${result[error.fieldId]} ${messages[error.code]}`
      : messages[error.code]
  }

  return result
}

function createCustomFieldValuePatch(
  definitions: readonly CustomFieldDefinition[],
  existingValues: Readonly<Record<string, CustomFieldValue>> | undefined,
  parsedValues: Readonly<Record<string, CustomFieldValue>>,
  projectId?: string,
) {
  const patch: Record<string, CustomFieldValue | null> = {}

  for (const definition of definitions) {
    if (definition.type === 'formula' || !isCustomFieldApplicable(definition, projectId)) {
      continue
    }

    if (Object.hasOwn(parsedValues, definition.id)) {
      patch[definition.id] = parsedValues[definition.id]!
    } else if (existingValues?.[definition.id] !== undefined) {
      patch[definition.id] = null
    }
  }

  return patch
}

function readSelectedRelationGraphRevision(
  detail: TeamIssueDetail | undefined,
  issueId: string,
) {
  if (detail?.issue.id !== issueId || detail.relationGraphRevision === undefined) {
    throw new Error('The latest relation graph is not loaded yet.')
  }

  return detail.relationGraphRevision
}

async function refreshRelationDetailAfterConflict(
  error: unknown,
  refresh: () => Promise<unknown>,
) {
  if (
    error instanceof WorkItemConfigurationApiError &&
    error.code === 'WorkItemRelationGraphConflict'
  ) {
    await refresh()
  }
}

function createTaskKey(task: ProjectTask) {
  return task.assignedProjectId || task.teamId
    ? `${task.assignedProjectId ?? ''}:${task.teamId ?? ''}:${task.id}`
    : task.id
}

function createTaskCalendarDays(tasks: ProjectTask[]) {
  const dates = Array.from(new Set(tasks.map((task) => task.dueDate)))
    .filter(Boolean)
    .sort()

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

function SearchIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
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

function CheckIcon() {
  return (
    <IconShell className="h-4 w-4">
      <path d="m5 12 4 4L19 6" />
    </IconShell>
  )
}
