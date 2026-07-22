import type {
  CustomFieldDefinition,
  ResolvedWorkItemConfiguration,
  WorkflowStatusCategory,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import {
  canManageWorkspaceStructure,
  canMutateWorkspaceContent,
  type DashboardSummary,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession, type AuthSession } from '../../auth/session'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { AutomationManagementPanelContainer } from '../../automation/ui/AutomationManagementPanelContainer'
import {
  MobileSidebarButton,
  WorkspaceSidebar,
  type SidebarNavId,
  type SidebarTeamViewId,
} from '../../shared/ui/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { NotificationInbox } from '../../notifications/ui/NotificationInbox'
import { NotificationSettingsPanel } from '../../notifications/ui/NotificationSettingsPanel'
import type { InboxNotification } from '../../notifications/api'
import { resolveNotificationPath } from '../../notifications/model/paths'
import {
  type NotificationInboxController,
  type NotificationPreferencesController,
  useNotificationInbox,
  useNotificationPreferences,
  useUnreadNotificationCount,
} from '../../notifications/mutations/useNotifications'
import { DeveloperPlatformPanelContainer } from '../../developer-platform/ui/DeveloperPlatformPanel'
import { createDeveloperPlatformLabels } from '../../developer-platform/ui/labels'
import { TeamIssuesApiError } from '../../issues/api'
import { updateWorkspaceTaskRemote } from '../../issues/mutations/updateWorkspaceTask'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../issues/model/workItemDisplay'
import {
  archiveProjectDirectoryProject,
  archiveProjectDirectoryTeam,
  createProjectDirectoryProject,
  createProjectDirectoryTeam,
  type CreateProjectDirectoryProjectInput,
  type CreateProjectDirectoryTeamInput,
  type ProjectDirectoryProject,
  type ProjectDirectoryTeam,
  type ProjectMember,
  type ProjectMemberRole,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import {
  useWorkspaceProjectMembers,
} from '../../projects/queries/useProjectMembers'
import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../../shared/routing/paths'
import {
  fontSizePreferenceOptions,
  getInitialFontSizePreference,
  setFontSizePreference as saveFontSizePreference,
  type FontSizePreference,
} from '../../shared/lib/preferences/fontSize'
import {
  type ProjectTask,
  type TaskPriority,
} from '../../tasks/api'
import {
  EnterpriseSecurityPanelContainer,
} from '../../security/ui/EnterpriseSecurityPanelContainer'
import type {
  EnterpriseSecurityScopeOption,
} from '../../security/ui/EnterpriseSecurityPanel'
import { WorkspaceAccessPanelContainer } from '../../workspace/ui/WorkspaceAccessPanel'
import { useWorkspaceCommandMenu } from '../../commands/ui/WorkspaceCommandMenuContext'
import {
  putWorkItemConfiguration,
  type WorkItemConfigurationScope,
} from '../../work-items/api'
import {
  useScopedWorkItemConfiguration,
  useTeamWorkItemConfigurations,
} from '../../work-items/queries/useWorkItemConfigurations'
import {
  WorkItemConfigurationPanel,
  type WorkItemConfigurationScopeOption,
} from '../../work-items/ui/WorkItemConfigurationPanel'
import { isCustomFieldApplicable } from '../../work-items/model/customFields'
import {
  formatWorkItemCustomFieldValue,
  isCompletedWorkItem,
  isOpenWorkItem,
  resolveEditableWorkflowStatuses,
  resolveWorkItemWorkflowStatusId,
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
} from '../../work-items/model/workItemDisplay'

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
  | 'enterprise-security'
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
 * Workspace report で選択できる Team-scoped custom field です。
 */
type ReportCustomFieldOption = {
  /** Selector value に使う Team と field の複合 key です。 */
  key: string
  /** Definition を所有する Team ID です。 */
  teamId: string
  /** Selector に表示する Team 名です。 */
  teamName: string
  /** 値の表示と filter に使う field definition です。 */
  definition: CustomFieldDefinition
}

/**
 * Report 用 configuration の一括取得結果です。
 */
type TeamWorkItemConfigurationLoadResult = {
  /** Team ID ごとに取得できた resolved configuration です。 */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Session policy を失わず shell へ伝える取得 error です。 */
  errors: unknown[]
  /** 取得に失敗した Team ID です。 */
  failedTeamIds: string[]
}

/**
 * Workspace 横断 kanban に表示する Team-scoped workflow status 列です。
 */
type WorkspaceTaskStatusColumn = {
  /**
   * React key と drag target に使う一意な列 ID です。
   */
  key: string
  /**
   * 複数 Team の同名 status を区別できる列見出しです。
   */
  label: string
  /**
   * Canonical Work Item の workflow を所有する Team ID です。
   */
  teamId: string
  /**
   * 列見出しと category tone に使う status definition です。
   */
  status: WorkflowStatusDefinition
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
   * 担当タスクに占める未完了タスクの百分率です。
   */
  openPercent: number
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
   * Workspace access API の Authorization header に使う access token です。
   */
  accessToken?: string
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
   * Workspace 既定の Work Item configuration を編集できるかどうかです。
   */
  canManageWorkspaceConfiguration?: boolean
  /**
   * Team manager 権限の server 判定を受ける configuration mutation を開始できるかどうかです。
   */
  canMutateTeamConfiguration?: boolean
  /**
   * チーム画面で選択中のチーム ID です。
   */
  activeTeamId?: string
  /**
   * 表示に使うタスク一覧です。
   */
  tasks: ProjectTask[]
  /**
   * Team ID ごとに解決された Work Item configuration です。
   */
  workItemConfigurationsByTeam?: Record<string, ResolvedWorkItemConfiguration>
  /**
   * Work Item configuration を取得できなかった Team ID です。
   */
  workItemConfigurationFailedTeamIds?: string[]
  /**
   * 失敗した Work Item configuration を再取得する callback です。
   */
  onRetryWorkItemConfigurations?: () => void
  /**
   * サイドバーに表示する通知の実未読件数です。
   */
  inboxCount?: number
  /**
   * notification-backed Inbox の data と action です。
   */
  notificationInbox?: NotificationInboxController
  /**
   * 通知配信設定の data と保存 action です。
   */
  notificationPreferences?: NotificationPreferencesController
  /**
   * タスク取得に失敗した projectId の一覧です。
   */
  taskLoadFailedProjectIds?: string[]
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
  onMoveTaskStatus?: (task: ProjectTask, workflowStatusId: string) => Promise<void>
  /**
   * ワークスペースのキュー行から作業詳細へ遷移するときの callback です。
   */
  onOpenTask?: (task: ProjectTask) => void
  /**
   * Inbox の通知対象へ遷移するときの callback です。
   */
  onOpenNotification?: (notification: InboxNotification) => void
  /**
   * フォントサイズ設定が変更されたときの callback です。
   */
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  /**
   * 表示言語が変更されたときの callback です。
   */
  onLocaleChange?: (locale: Locale) => void
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
const emptyProjectTaskFailures: string[] = []
const emptyTeamProjectMembers: TeamProjectMemberAccess[] = []
const emptyTeamProjectMemberFailures: string[] = []
const emptyUserIdentityAliases: string[] = []
const emptyResolvedWorkItemConfigurations: Record<string, ResolvedWorkItemConfiguration> = {}
const emptyTeamWorkItemConfigurationLoadResult: TeamWorkItemConfigurationLoadResult = {
  configurationsByTeam: emptyResolvedWorkItemConfigurations,
  errors: [],
  failedTeamIds: [],
}
const reportStatusOrder = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const satisfies readonly WorkflowStatusCategory[]
const reportPriorityOrder = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]

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
  'enterprise-security': {
    activeNavId: 'settings',
    eyebrowKey: 'security.page.eyebrow',
    titleKey: 'security.page.title',
    descriptionKey: 'security.page.description',
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
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState<AuthSession | null>(() => getAuthSession())
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const [authenticatedApiError, setAuthenticatedApiError] = useState<unknown>()
  const [fontSizePreference, setFontSizePreferenceState] = useState<FontSizePreference>(() =>
    getInitialFontSizePreference(),
  )
  const t = useMemo(() => createTranslator(locale), [locale])
  const accessToken = session?.accessToken
  const notificationInbox = useNotificationInbox(accessToken, view === 'inbox')
  const notificationPreferences = useNotificationPreferences(accessToken, view === 'settings')
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken)
  const {
    data: teams = emptyProjectDirectory,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
    mutate: mutateProjectDirectory,
  } = useProjectDirectory({
    accessToken,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const projectIds = useMemo(() => uniqueProjectIds(teams), [teams])
  const activeTeam = useMemo(() => findActiveTeam(teams, params.teamId), [params.teamId, teams])
  const activeTeamProjects = activeTeam?.projects ?? []
  const isTeamManagementView = view === 'team-overview' || view === 'team-members'
  const needsWorkspaceWorkItems = ![
    'help',
    'settings',
    'enterprise-security',
  ].includes(view)
  const {
    data: tasks = emptyProjectTasks,
    error: workspaceWorkItemsError,
    isLoading: isWorkspaceWorkItemsLoading,
    mutate: mutateWorkspaceWorkItems,
    key: workspaceWorkItemsKey,
  } = useWorkspaceWorkItems(
    accessToken,
    Boolean(user && !currentUserError && needsWorkspaceWorkItems),
  )
  const workItemConfigurationTeamIds = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.teamId))).sort(),
    [tasks],
  )
  const taskLoadFailedProjectIds = workspaceWorkItemsError
    ? projectIds
    : emptyProjectTaskFailures
  const {
    data: workItemConfigurationLoadResult = emptyTeamWorkItemConfigurationLoadResult,
    error: workItemConfigurationsError,
    isLoading: isWorkItemConfigurationsLoading,
    mutate: mutateWorkItemConfigurations,
    key: workItemConfigurationsKey,
  } = useTeamWorkItemConfigurations(
    accessToken,
    'workspace',
    workItemConfigurationTeamIds,
    Boolean(user && !currentUserError && needsWorkspaceWorkItems),
  )
  const {
    data: teamProjectMembersResult,
    error: teamProjectMembersError,
    isLoading: isTeamProjectMembersLoading,
    key: teamProjectMembersKey,
  } = useWorkspaceProjectMembers(
    accessToken,
    activeTeam?.id,
    activeTeamProjects,
    Boolean(user && !currentUserError && isTeamManagementView),
  )
  const [taskMoveErrorMessage, setTaskMoveErrorMessage] = useState<string | undefined>()
  const pendingTaskMoveKeysRef = useRef(new Set<string>())
  const summary = useMemo(() => createDashboardSummary(teams, tasks), [tasks, teams])
  const metadata = workspaceViewMetadata[view]
  const title = formatTeamText(
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
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      projectDirectoryError,
      workspaceWorkItemsError,
      workItemConfigurationsError,
      ...workItemConfigurationLoadResult.errors,
      teamProjectMembersError,
      ...(teamProjectMembersResult?.errors ?? []),
      ...(notificationInbox.sessionErrors ?? []),
      ...(notificationPreferences.sessionErrors ?? []),
      authenticatedApiError,
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const guardEnterpriseSession = async <Result,>(request: Promise<Result>) => {
    try {
      return await request
    } catch (error) {
      setAuthenticatedApiError(() => error)
      throw error
    }
  }
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay') ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(
      user &&
      view !== 'inbox' &&
      workspaceWorkItemsKey &&
      isWorkspaceWorkItemsLoading,
    ) || Boolean(workItemConfigurationsKey && isWorkItemConfigurationsLoading)

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
    if (currentUserErrorAction?.redirectTo) {
      if (currentUserErrorAction.clearSession) {
        clearAuthSession()
      }
      navigate(currentUserErrorAction.redirectTo, { replace: true })
    }
  }, [
    currentUserErrorAction?.clearSession,
    currentUserErrorAction?.redirectTo,
    navigate,
  ])

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

    await guardEnterpriseSession(mutationRequestRunner.run('team:create', JSON.stringify(input), (context) =>
      createProjectDirectoryTeam(accessToken, input, context),
    ))
    await mutateProjectDirectory()
  }

  const handleCreateProject = async (
    teamId: string,
    input: CreateProjectDirectoryProjectInput,
  ) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'project:create',
      JSON.stringify([teamId, input]),
      (context) => createProjectDirectoryProject(accessToken, teamId, input, context),
    ))
    await mutateProjectDirectory()
  }

  const handleArchiveTeam = async (teamId: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run('team:archive', teamId, (context) =>
      archiveProjectDirectoryTeam(accessToken, teamId, context),
    ))
    await mutateProjectDirectory()

    if (params.teamId === teamId) {
      navigate(workspaceNavPaths.home)
    }
  }

  const handleArchiveProject = async (teamId: string, projectId: string) => {
    if (!accessToken) {
      return
    }

    await guardEnterpriseSession(mutationRequestRunner.run(
      'project:archive',
      JSON.stringify([teamId, projectId]),
      (context) => archiveProjectDirectoryProject(accessToken, teamId, projectId, context),
    ))
    await mutateProjectDirectory()
  }

  const handleMoveTaskStatus = async (task: ProjectTask, workflowStatusId: string) => {
    const canonicalTask = tasks.find(
      (candidate) => createWorkspaceTaskKey(candidate) === createWorkspaceTaskKey(task),
    )

    if (
      !accessToken ||
      !canonicalTask ||
      canonicalTask.workflowStatusId === workflowStatusId
    ) {
      return
    }

    const configuration = workItemConfigurationLoadResult.configurationsByTeam[canonicalTask.teamId]
      ?.configuration
    const nextStatus = configuration?.workflow.statuses.find(
      (status) => status.id === workflowStatusId,
    )

    if (!nextStatus) {
      return
    }

    setTaskMoveErrorMessage(undefined)
    const taskKey = createWorkspaceTaskKey(canonicalTask)
    if (pendingTaskMoveKeysRef.current.has(taskKey)) {
      return
    }

    pendingTaskMoveKeysRef.current.add(taskKey)
    const nextTasks = updateWorkspaceTaskStatus(
      tasks,
      canonicalTask,
      nextStatus,
      canonicalTask.workflowStatusId,
    )

    try {
      await mutateWorkspaceWorkItems(
        (currentTasks = tasks) =>
          updateWorkspaceTaskStatus(
            currentTasks,
            canonicalTask,
            nextStatus,
            canonicalTask.workflowStatusId,
          ),
        { revalidate: false },
      )
      const updatedTask = await guardEnterpriseSession(mutationRequestRunner.run(
        `task:status:${taskKey}`,
        JSON.stringify([canonicalTask.revision, workflowStatusId]),
        (context) => updateWorkspaceTaskRemote(
          canonicalTask,
          accessToken,
          workflowStatusId,
          context,
        ),
      ))
      await mutateWorkspaceWorkItems(
        (currentTasks = nextTasks) => replaceWorkspaceTask(currentTasks, updatedTask),
        {
          revalidate: false,
        },
      )
    } catch (error) {
      await mutateWorkspaceWorkItems(
        (currentTasks = nextTasks) =>
          replaceWorkspaceTask(currentTasks, canonicalTask),
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
      canManageWorkspaceConfiguration={canManageStructure}
      canMutateTeamConfiguration={canMutateContent}
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
      onRetryWorkItemConfigurations={() => void mutateWorkItemConfigurations()}
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
      workItemConfigurationFailedTeamIds={workItemConfigurationLoadResult.failedTeamIds}
      workItemConfigurationsByTeam={workItemConfigurationLoadResult.configurationsByTeam}
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
  accessToken,
  canManageWorkspaceConfiguration = false,
  canMutateTeamConfiguration = false,
  locale,
  view,
  userLabel,
  userIdentityAliases = emptyUserIdentityAliases,
  userInitial,
  summary,
  teams,
  activeTeamId,
  tasks,
  inboxCount = 0,
  notificationInbox,
  notificationPreferences,
  taskLoadFailedProjectIds = emptyProjectTaskFailures,
  workItemConfigurationFailedTeamIds = emptyProjectTaskFailures,
  workItemConfigurationsByTeam = emptyResolvedWorkItemConfigurations,
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
  onRetryWorkItemConfigurations,
  onOpenNotification,
  onOpenTask,
  onFontSizePreferenceChange,
  onLocaleChange,
  taskMoveErrorMessage,
}: WorkspaceScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const metadata = workspaceViewMetadata[view]
  const activeTeam = findActiveTeam(teams, activeTeamId)
  const activeTeamLabel = activeTeam?.name ?? t('workspace.team.missing')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const commandMenu = useWorkspaceCommandMenu()

  return (
    <main className="workbench-shell flex h-svh min-h-0 overflow-hidden">
      <WorkspaceSidebar
        activeNavId={metadata.activeNavId}
        activeTeamId={metadata.activeTeamViewId ? activeTeam?.id : undefined}
        activeTeamViewId={metadata.activeTeamViewId}
        inboxCount={inboxCount}
        isMobileOpen={isMobileSidebarOpen}
        labels={sidebarLabels}
        mobileCloseLabel={t('sidebar.mobileClose')}
        mobileDialogLabel={t('sidebar.mobileDialog')}
        onArchiveProject={onArchiveProject}
        onArchiveTeam={onArchiveTeam}
        onCreateProject={onCreateProject}
        onCreateTeam={onCreateTeam}
        onMobileClose={() => setIsMobileSidebarOpen(false)}
        onOpenSearch={commandMenu.open}
        onSelectNav={onSelectNav}
        onSelectProject={onSelectProject}
        onSelectTeamView={onSelectTeamView}
        teams={teams}
      />

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
                  {formatTeamText(t(metadata.titleKey), activeTeamLabel)}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {formatTeamText(t(metadata.descriptionKey), activeTeamLabel)}
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
              accessToken={accessToken}
              activeTeam={activeTeam}
              canManageWorkspaceConfiguration={canManageWorkspaceConfiguration}
              canMutateTeamConfiguration={canMutateTeamConfiguration}
              fontSizePreference={fontSizePreference}
              locale={locale}
              notificationInbox={notificationInbox}
              notificationPreferences={notificationPreferences}
              summary={summary}
              t={t}
              taskMoveErrorMessage={taskMoveErrorMessage}
              taskLoadFailedProjectIds={taskLoadFailedProjectIds}
              tasks={tasks}
              workItemConfigurationFailedTeamIds={workItemConfigurationFailedTeamIds}
              workItemConfigurationsByTeam={workItemConfigurationsByTeam}
              teamProjectMembers={teamProjectMembers}
              teamProjectMembersFailedProjectIds={teamProjectMembersFailedProjectIds}
              teams={teams}
              isTeamProjectMembersLoading={isTeamProjectMembersLoading}
              onFontSizePreferenceChange={onFontSizePreferenceChange}
              onLocaleChange={onLocaleChange}
              onMoveTaskStatus={onMoveTaskStatus}
              onRetryWorkItemConfigurations={onRetryWorkItemConfigurations}
              onOpenNotification={onOpenNotification}
              onOpenTask={onOpenTask}
              onSelectProject={onSelectProject}
              userLabel={userLabel}
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
  accessToken,
  activeTeam,
  canManageWorkspaceConfiguration,
  canMutateTeamConfiguration,
  fontSizePreference,
  locale,
  notificationInbox,
  notificationPreferences,
  summary,
  t,
  taskMoveErrorMessage,
  taskLoadFailedProjectIds,
  tasks,
  workItemConfigurationFailedTeamIds,
  workItemConfigurationsByTeam,
  teamProjectMembers,
  teamProjectMembersFailedProjectIds,
  teams,
  isTeamProjectMembersLoading,
  onFontSizePreferenceChange,
  onLocaleChange,
  onMoveTaskStatus,
  onRetryWorkItemConfigurations,
  onOpenNotification,
  onOpenTask,
  onSelectProject,
  userLabel,
  userIdentityAliases,
  view,
}: {
  accessToken?: string
  activeTeam?: ProjectDirectoryTeam
  canManageWorkspaceConfiguration: boolean
  canMutateTeamConfiguration: boolean
  fontSizePreference: FontSizePreference
  locale: Locale
  notificationInbox?: NotificationInboxController
  notificationPreferences?: NotificationPreferencesController
  summary: DashboardSummary
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  taskLoadFailedProjectIds: string[]
  tasks: ProjectTask[]
  workItemConfigurationFailedTeamIds: string[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  teams: ProjectDirectoryTeam[]
  isTeamProjectMembersLoading: boolean
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  onLocaleChange?: (locale: Locale) => void
  onMoveTaskStatus?: (task: ProjectTask, workflowStatusId: string) => Promise<void>
  onRetryWorkItemConfigurations?: () => void
  onOpenNotification?: (notification: InboxNotification) => void
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  userLabel: string
  userIdentityAliases: string[]
  view: WorkspaceView
}) {
  const myTasks = userIdentityAliases.length === 0
    ? emptyProjectTasks
    : tasks.filter((task) =>
        isWorkspaceTaskAssignedToUser(task, userIdentityAliases),
      )

  return (
    <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
      {taskLoadFailedProjectIds.length > 0 ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
          data-testid="workspace-task-partial-error"
          role="alert"
        >
          {t('tasks.error.loading')} ({taskLoadFailedProjectIds.length})
        </p>
      ) : null}
      {view === 'my-tasks' && workItemConfigurationFailedTeamIds.length > 0 ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
          data-testid="my-tasks-configuration-error"
          role="alert"
        >
          <span>{t('workItems.configuration.loadError')}</span>
          {onRetryWorkItemConfigurations ? (
            <button
              className="underline underline-offset-2"
              onClick={onRetryWorkItemConfigurations}
              type="button"
            >
              {t('collaboration.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {view === 'home' ? (
        <HomeView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'my-tasks' ? (
        <MyTasksView
          configurationFailedTeamIds={workItemConfigurationFailedTeamIds}
          configurationsByTeam={workItemConfigurationsByTeam}
          onOpenTask={onOpenTask}
          t={t}
          taskMoveErrorMessage={taskMoveErrorMessage}
          tasks={myTasks}
          teams={teams}
          onMoveTaskStatus={onMoveTaskStatus}
        />
      ) : null}
      {view === 'inbox' ? (
        notificationInbox ? (
          <InboxWorkspaceView
            locale={locale}
            notificationInbox={notificationInbox}
            onOpenNotification={onOpenNotification}
            onOpenTask={onOpenTask}
            t={t}
            tasks={tasks}
            teams={teams}
            workItemConfigurationsByTeam={workItemConfigurationsByTeam}
          />
        ) : null
      ) : null}
      {view === 'dashboard' ? (
        <DashboardWorkspaceView
          summary={summary}
          t={t}
          tasks={tasks}
          teams={teams}
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {view === 'reports' ? (
        <ReportsView
          configurationFailedTeamIds={workItemConfigurationFailedTeamIds}
          configurationsByTeam={workItemConfigurationsByTeam}
          locale={locale}
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
          accessToken={accessToken}
          canManageWorkspaceConfiguration={canManageWorkspaceConfiguration}
          canMutateTeamConfiguration={canMutateTeamConfiguration}
          fontSizePreference={fontSizePreference}
          locale={locale}
          notificationPreferences={notificationPreferences}
          t={t}
          teams={teams}
          userLabel={userLabel}
          onFontSizePreferenceChange={onFontSizePreferenceChange}
          onLocaleChange={onLocaleChange}
        />
      ) : null}
      {view === 'enterprise-security' && accessToken ? (
        <EnterpriseSecurityPanelContainer
          accessToken={accessToken}
          locale={locale}
          scopeOptions={createEnterpriseSecurityScopeOptions(
            teams,
            t('security.scope.workspace'),
          )}
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
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
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
  workItemConfigurationsByTeam,
}: {
  onOpenTask?: (task: ProjectTask) => void
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
}) {
  const nextTasks = createActionQueueTasks(tasks).slice(0, 3)
  const attentionTasks = createInboxTasks(tasks).slice(0, 3)

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
                configuration={resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam)}
                key={createWorkspaceTaskKey(task)}
                t={t}
                task={task}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel">
          <SectionHeader
            title={t('workspace.reports.attentionTitle')}
            meta={t('workspace.reports.attentionMeta')}
          />
          <div className="grid gap-3 px-5 pb-5">
            {attentionTasks.map((task) => (
              <button
                className="rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:hover:border-[var(--workbench-border)] disabled:hover:bg-white"
                disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
                key={createWorkspaceTaskKey(task)}
                onClick={() => onOpenTask?.(task)}
                type="button"
              >
                <p className="text-sm font-semibold text-[var(--workbench-text)]">{resolveTaskTitle(task, t)}</p>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {resolveTaskAssignee(task, t)} / {resolveWorkItemWorkflowStatusLabel(
                    task,
                    resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam),
                  )} / {task.dueDate}
                </p>
              </button>
            ))}
            {attentionTasks.length === 0 ? (
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
  configurationFailedTeamIds,
  configurationsByTeam,
  onOpenTask,
  t,
  taskMoveErrorMessage,
  tasks,
  teams,
  onMoveTaskStatus,
}: {
  /** Work Item configuration の取得に失敗した Team ID です。 */
  configurationFailedTeamIds: string[]
  /** Team ID ごとに解決済みの Work Item configuration です。 */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  taskMoveErrorMessage?: string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  onMoveTaskStatus?: (task: ProjectTask, workflowStatusId: string) => Promise<void>
}) {
  const [draggedTaskKey, setDraggedTaskKey] = useState<string | undefined>()
  const [dropTargetColumnKey, setDropTargetColumnKey] = useState<string | undefined>()
  const [movingTaskKeys, setMovingTaskKeys] = useState<ReadonlySet<string>>(() => new Set())
  const canMoveTasks = Boolean(onMoveTaskStatus)
  const statusColumns = useMemo(
    () => createWorkspaceTaskStatusColumns(tasks, configurationsByTeam, teams),
    [configurationsByTeam, tasks, teams],
  )
  const configurationUnavailableTasks = useMemo(
    () => tasks.filter((task) =>
      configurationFailedTeamIds.includes(task.teamId),
    ),
    [configurationFailedTeamIds, tasks],
  )

  const moveTaskToStatus = (task: ProjectTask, workflowStatusId: string) => {
    if (
      !onMoveTaskStatus ||
      task.workflowStatusId === workflowStatusId
    ) {
      return
    }

    const configuration = configurationsByTeam[task.teamId]?.configuration
    const allowedStatuses = resolveEditableWorkflowStatuses(task, configuration)

    if (!allowedStatuses.some((status) => status.id === workflowStatusId)) {
      return
    }

    const taskKey = createWorkspaceTaskKey(task)

    setDraggedTaskKey(undefined)
    setDropTargetColumnKey(undefined)
    setMovingTaskKeys((currentTaskKeys) => new Set(currentTaskKeys).add(taskKey))
    void onMoveTaskStatus(task, workflowStatusId)
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
    setDropTargetColumnKey(undefined)
  }

  const handleDragOver = (
    event: DragEvent<HTMLElement>,
    column: WorkspaceTaskStatusColumn,
  ) => {
    const carriesTaskKey = draggedTaskKey ||
      event.dataTransfer.types.includes('application/x-mukuroji-task-key') ||
      event.dataTransfer.types.includes('text/plain')

    const draggedTask = draggedTaskKey
      ? findWorkspaceTaskByKey(tasks, draggedTaskKey)
      : undefined

    if (
      !canMoveTasks ||
      !carriesTaskKey ||
      (draggedTask && column.teamId !== draggedTask.teamId)
    ) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetColumnKey(column.key)
  }

  const handleDrop = (
    event: DragEvent<HTMLElement>,
    column: WorkspaceTaskStatusColumn,
  ) => {
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

    if (column.teamId === task.teamId) {
      moveTaskToStatus(task, column.status.id)
    }
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
        className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2 max-[900px]:grid-flow-row max-[900px]:grid-cols-1 max-[900px]:overflow-visible max-[900px]:pb-0"
        data-testid="my-tasks-kanban"
      >
        {statusColumns.map((column) => {
          const columnTasks = tasks.filter((task) => isTaskInWorkspaceStatusColumn(task, column))
          const isDropTarget = dropTargetColumnKey === column.key

          return (
            <section
              aria-label={column.label}
              className={`workbench-panel min-h-[420px] min-w-[260px] transition ${
                isDropTarget ? 'border-[#99d7cf] bg-[#e5f7f4] ring-2 ring-[#99d7cf]/40' : ''
              }`}
              data-testid={`my-tasks-column-${createWorkspaceTaskTestToken(column.key)}`}
              key={column.key}
              onDragLeave={() => setDropTargetColumnKey(undefined)}
              onDragOver={(event) => handleDragOver(event, column)}
              onDrop={(event) => handleDrop(event, column)}
            >
              <SectionHeader
                title={column.label}
                meta={t('tasks.board.columnCount').replace('{count}', String(columnTasks.length))}
              />
              <div className="grid gap-3 px-4 pb-4">
                {columnTasks.map((task) => {
                  const taskKey = createWorkspaceTaskKey(task)
                  const isMoving = movingTaskKeys.has(taskKey)
                  const configuration = configurationsByTeam[task.teamId]?.configuration
                  const editableStatuses = resolveEditableWorkflowStatuses(task, configuration)

                  return (
                    <CompactTaskCard
                      configuration={configuration}
                      draggable={canMoveTasks && !isMoving}
                      isDragging={draggedTaskKey === taskKey}
                      isMoving={isMoving}
                      key={taskKey}
                      t={t}
                      task={task}
                      testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                      onDragEnd={handleDragEnd}
                      onDragStart={(event) => handleDragStart(event, task)}
                      onOpenTask={onOpenTask}
                      onStatusChange={!onMoveTaskStatus
                        ? undefined
                        : (nextStatus) => moveTaskToStatus(task, nextStatus)}
                      workflowStatuses={editableStatuses}
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
        {configurationUnavailableTasks.length > 0 ? (
          <section
            aria-label={t('workItems.configuration.loadError')}
            className="workbench-panel min-h-[420px] min-w-[260px] border-amber-200"
            data-testid="my-tasks-configuration-unavailable-column"
          >
            <SectionHeader
              title={t('workItems.configuration.loadError')}
              meta={t('tasks.board.columnCount').replace(
                '{count}',
                String(configurationUnavailableTasks.length),
              )}
            />
            <div className="grid gap-3 px-4 pb-4">
              {configurationUnavailableTasks.map((task) => (
                <CompactTaskCard
                  draggable={false}
                  key={createWorkspaceTaskKey(task)}
                  t={t}
                  task={task}
                  testId={`my-tasks-card-${createWorkspaceTaskTestId(task)}`}
                  onOpenTask={onOpenTask}
                  workflowStatuses={[]}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}

function InboxWorkspaceView({
  locale,
  notificationInbox,
  onOpenNotification,
  onOpenTask,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: {
  locale: Locale
  notificationInbox: NotificationInboxController
  onOpenNotification?: (notification: InboxNotification) => void
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
}) {
  const [sourceFilter, setSourceFilter] = useState<'all' | 'approval'>('all')
  const inboxTasks = createInboxTasks(tasks)
  const approvalTaskCount = inboxTasks.filter(hasApprovalAttention).length
  const filteredTasks = sourceFilter === 'approval'
    ? inboxTasks.filter(hasApprovalAttention)
    : inboxTasks
  const showAttentionQueue = inboxTasks.length > 0 || sourceFilter === 'approval'

  return (
    <div className="grid gap-5" data-testid="inbox-workbench">
      <section className="workbench-toolbar flex min-w-0 flex-wrap items-center justify-between gap-3 p-4">
        <div
          aria-label={t('workspace.inbox.scopeTitle')}
          className="inline-flex min-w-0 flex-wrap gap-1 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-1"
          role="group"
        >
          <button
            aria-pressed={sourceFilter === 'all'}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold tracking-[0.01em] transition ${
              sourceFilter === 'all'
                ? 'bg-white text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.08)]'
                : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
            }`}
            data-testid="inbox-filter-all"
            onClick={() => setSourceFilter('all')}
            type="button"
          >
            {t('workspace.inbox.filter.all')}
          </button>
          <button
            aria-pressed={sourceFilter === 'approval'}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold tracking-[0.01em] transition ${
              sourceFilter === 'approval'
                ? 'bg-white text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.08)]'
                : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
            }`}
            data-testid="inbox-filter-approval"
            onClick={() => setSourceFilter('approval')}
            type="button"
          >
            {t('workspace.inbox.filter.approval')}
            {approvalTaskCount > 0 ? (
              <span className="ml-2 rounded-full bg-[var(--workbench-primary)] px-2 py-0.5 text-xs font-bold text-white">
                {approvalTaskCount}
              </span>
            ) : null}
          </button>
        </div>
        <p className="text-sm font-semibold text-[var(--workbench-muted)]">
          {t('workspace.inbox.scopeDescription')}
        </p>
      </section>

      {showAttentionQueue ? (
        <InboxAttentionQueue
          onOpenTask={onOpenTask}
          t={t}
          tasks={filteredTasks}
          teams={teams}
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        />
      ) : null}

      <NotificationInbox
        controller={notificationInbox}
        locale={locale}
        onOpenNotification={onOpenNotification}
      />
    </div>
  )
}

function InboxAttentionQueue({
  onOpenTask,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: {
  onOpenTask?: (task: ProjectTask) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
}) {
  return (
    <section className="workbench-panel overflow-hidden">
      <SectionHeader
        title={t('workspace.inbox.queueTitle')}
        meta={t('workspace.inbox.queueMeta').replace('{count}', String(tasks.length))}
      />
      <div className="divide-y divide-[var(--workbench-border)]" data-testid="inbox-task-list">
        {tasks.map((task) => {
          const reasonKeys = createInboxReasonKeys(task)

          return (
            <button
              className="grid w-full grid-cols-[minmax(220px,1fr)_minmax(170px,0.7fr)_auto] items-center gap-5 p-5 text-left transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[860px]:grid-cols-1"
              data-testid={`inbox-task-${createInboxTaskTestId(task)}`}
              disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
              key={createWorkspaceTaskKey(task)}
              onClick={() => onOpenTask?.(task)}
              type="button"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {resolveTaskTitle(task, t)}
                </span>
                <span className="mt-1 block truncate text-sm font-medium text-[var(--workbench-muted)]">
                  {resolveWorkspaceProjectName(task, teams)} · {resolveTaskAssignee(task, t)}
                </span>
                <span className="mt-3 flex flex-wrap gap-2">
                  {reasonKeys.map((reasonKey) => (
                    <span className={resolveInboxReasonClassName(reasonKey)} key={reasonKey}>
                      {t(reasonKey)}
                    </span>
                  ))}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <StatusPill
                  configuration={resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam)}
                  task={task}
                />
                <PriorityPill priority={task.priority} t={t} />
                <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                  {task.dueDate}
                </span>
              </span>
              <span className="workbench-badge justify-self-end max-[860px]:justify-self-start">
                {t('workspace.action.openTask')}
              </span>
            </button>
          )
        })}
        {tasks.length === 0 ? (
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
  )
}

function DashboardWorkspaceView({
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: {
  onOpenTask?: (task: ProjectTask) => void
  summary: DashboardSummary
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
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
        <MetricCard label={t('workspace.reports.metric.completion')} value={`${calculateProjectProgress(tasks)}%`} tone="amber" />
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
                    <ProgressBar
                      label={`${project.name} ${t('workspace.column.progress')}`}
                      value={project.progress}
                    />
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
              configuration={resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam)}
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
  configurationFailedTeamIds,
  configurationsByTeam,
  locale,
  onOpenTask,
  onSelectProject,
  t,
  tasks,
  teams,
}: {
  configurationFailedTeamIds: string[]
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  locale: Locale
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  teams: ProjectDirectoryTeam[]
}) {
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [showAttentionOnly, setShowAttentionOnly] = useState(false)
  const [selectedCustomFieldKey, setSelectedCustomFieldKey] = useState('')
  const [customFieldValueQuery, setCustomFieldValueQuery] = useState('')
  const customFieldOptions = useMemo<ReportCustomFieldOption[]>(() =>
    teams.flatMap((team) =>
      (configurationsByTeam[team.id]?.configuration.customFields ?? []).map((definition) => ({
        definition,
        key: `${team.id}:${definition.id}`,
        teamId: team.id,
        teamName: team.name,
      })),
    ), [configurationsByTeam, teams])
  const selectedCustomField = customFieldOptions.find(
    (option) => option.key === selectedCustomFieldKey,
  )
  const normalizedCustomFieldValueQuery = normalizeWorkspaceSearchText(customFieldValueQuery)
  const reportTasks = selectedCustomField
    ? tasks.filter((task) => {
        if (task.teamId !== selectedCustomField.teamId) {
          return false
        }
        if (!isCustomFieldApplicable(
          selectedCustomField.definition,
          task.assignedProjectId,
        )) {
          return false
        }
        if (!normalizedCustomFieldValueQuery) {
          return true
        }
        return normalizeWorkspaceSearchText(formatReportCustomFieldValue(
          task,
          selectedCustomField.definition,
          locale,
        )).includes(normalizedCustomFieldValueQuery)
      })
    : tasks
  const openTasks = reportTasks.filter((task) => isOpenWorkItem(task))
  const attentionTasks = createInboxTasks(reportTasks)
  const projectRows = createReportProjectRows(teams, reportTasks)
  const normalizedProjectSearchQuery = normalizeWorkspaceSearchText(projectSearchQuery)
  const filteredProjectRows = projectRows.filter((project) => {
    if (showAttentionOnly && project.attentionTaskCount === 0) {
      return false
    }

    return !normalizedProjectSearchQuery ||
      normalizeWorkspaceSearchText(`${project.name} ${project.teamName}`).includes(normalizedProjectSearchQuery)
  })
  const statusItems = reportStatusOrder.map((category) => ({
    count: reportTasks.filter(
      (task) => resolveWorkflowStatusCategory(task) === category,
    ).length,
    id: category,
    label: t(`workItems.statusCategory.${category}`),
  }))
  const priorityItems = reportPriorityOrder.map((priority) => ({
    count: openTasks.filter((task) => task.priority === priority).length,
    id: priority,
    label: t(`tasks.priority.${priority}`),
  }))
  const attentionProjectCount = projectRows.filter((project) => project.attentionTaskCount > 0).length
  const pendingApprovalCount = reportTasks.reduce(
    (count, task) => count + (task.approvalSummary?.pendingCount ?? 0),
    0,
  )
  const overdueApprovalCount = reportTasks.reduce(
    (count, task) => count + (task.approvalSummary?.overdueCount ?? 0),
    0,
  )
  const customFieldDistribution = selectedCustomField
    ? createCustomFieldDistribution(reportTasks, selectedCustomField.definition, locale)
    : []

  return (
    <div className="grid gap-6" data-testid="reports-workbench">
      {configurationFailedTeamIds.length > 0 ? (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900"
          role="alert"
        >
          {t('workspace.reports.configurationPartialError')}
        </p>
      ) : null}
      <section className="workbench-toolbar grid grid-cols-[minmax(0,1fr)_minmax(260px,340px)_minmax(220px,300px)_auto] items-end gap-4 p-4 max-[1120px]:grid-cols-2 max-[680px]:grid-cols-1">
        <div>
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.reports.snapshotTitle')}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.reports.snapshotDescription')}
          </p>
        </div>
        <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('workspace.reports.customFieldFilterLabel')}
          <select
            className="workbench-input min-h-10 min-w-0 px-3 normal-case tracking-normal"
            data-testid="reports-custom-field-filter"
            value={selectedCustomFieldKey}
            onChange={(event) => {
              setSelectedCustomFieldKey(event.target.value)
              setCustomFieldValueQuery('')
            }}
          >
            <option value="">{t('workspace.reports.customFieldFilterAll')}</option>
            {customFieldOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.teamName} · {option.definition.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('workspace.reports.customFieldValueLabel')}
          <input
            className="workbench-input min-h-10 min-w-0 px-3 normal-case tracking-normal"
            data-testid="reports-custom-field-value-filter"
            disabled={!selectedCustomField}
            placeholder={t('workspace.reports.customFieldValuePlaceholder')}
            type="search"
            value={customFieldValueQuery}
            onChange={(event) => setCustomFieldValueQuery(event.target.value)}
          />
        </label>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          data-testid="reports-export-csv"
          onClick={() => downloadWorkspaceReportCsv(filteredProjectRows, t)}
          type="button"
        >
          {t('workspace.reports.exportCsv')}
        </button>
      </section>

      <div className="grid grid-cols-6 gap-4 max-[1380px]:grid-cols-3 max-[980px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard
          label={t('workspace.reports.metric.open')}
          testId="reports-metric-open"
          value={openTasks.length}
          tone="teal"
        />
        <MetricCard
          label={t('workspace.reports.metric.completion')}
          testId="reports-metric-completion"
          value={`${calculateProjectProgress(reportTasks)}%`}
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
        <MetricCard
          label={t('workspace.reports.metric.pendingApprovals')}
          testId="reports-metric-pending-approvals"
          value={pendingApprovalCount}
          tone="teal"
        />
        <MetricCard
          label={t('workspace.reports.metric.overdueApprovals')}
          testId="reports-metric-overdue-approvals"
          value={overdueApprovalCount}
          tone="red"
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
                total={reportTasks.length}
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

      {selectedCustomField ? (
        <section className="workbench-panel overflow-hidden" data-testid="reports-custom-field-distribution">
          <SectionHeader
            title={t('workspace.reports.customFieldDistributionTitle').replace(
              '{field}',
              selectedCustomField.definition.name,
            )}
            meta={t('workspace.reports.customFieldDistributionMeta').replace(
              '{team}',
              selectedCustomField.teamName,
            )}
          />
          <div className="grid gap-4 border-t border-[var(--workbench-border)] p-5">
            {customFieldDistribution.map((item) => (
              <ReportDistributionRow
                count={item.count}
                key={item.label}
                label={item.label}
                toneClassName="bg-[var(--workbench-primary)]"
                total={reportTasks.length}
              />
            ))}
            {customFieldDistribution.length === 0 ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]">
                {t('workspace.empty.tasks')}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

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
          <table className="w-full min-w-[1160px] border-collapse text-left" data-testid="reports-project-table">
            <thead>
              <tr className="workbench-table-head text-left">
                <th className="px-5 py-3" scope="col">{t('workspace.column.project')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.team')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.column.progress')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.open')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.review')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.attention')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.pendingApprovals')}</th>
                <th className="px-5 py-3" scope="col">{t('workspace.reports.column.overdueApprovals')}</th>
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
                        <ProgressBar
                          label={`${project.name} ${t('workspace.column.progress')}`}
                          value={project.progress}
                        />
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
                  <td className="px-5 py-4 tabular-nums">{project.pendingApprovalCount}</td>
                  <td className="px-5 py-4">
                    <span className={project.overdueApprovalCount > 0 ? 'workbench-badge-danger' : 'workbench-badge-success'}>
                      {project.overdueApprovalCount}
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
              configuration={resolveWorkspaceTaskConfiguration(task, configurationsByTeam)}
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

const helpDestinations = [
  {
    descriptionKey: 'workspace.help.guideDescription',
    titleKey: 'workspace.help.guideTitle',
    to: '/home',
  },
  {
    descriptionKey: 'workspace.help.runbookDescription',
    titleKey: 'workspace.help.runbookTitle',
    to: '/reports',
  },
  {
    descriptionKey: 'workspace.help.supportDescription',
    titleKey: 'workspace.help.supportTitle',
    to: '/support',
  },
  {
    descriptionKey: 'workspace.help.statusDescription',
    titleKey: 'workspace.help.statusTitle',
    to: '/support?topic=work',
  },
] as const satisfies ReadonlyArray<{
  descriptionKey: MessageKey
  titleKey: MessageKey
  to: string
}>

function HelpView({ t }: { t: (key: MessageKey) => string }) {
  return (
    <nav
      aria-label={t('workspace.help.title')}
      className="grid grid-cols-2 gap-4 max-[820px]:grid-cols-1"
    >
      {helpDestinations.map((destination) => (
        <Link
          className="group workbench-panel grid min-h-[168px] grid-cols-[1fr_auto] gap-5 p-5 no-underline transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]"
          key={destination.titleKey}
          to={destination.to}
        >
          <span>
            <strong className="block text-lg font-semibold text-[var(--workbench-text)]">
              {t(destination.titleKey)}
            </strong>
            <span className="mt-3 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t(destination.descriptionKey)}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center self-end rounded-full border border-[var(--workbench-border-strong)] bg-white text-lg text-[var(--workbench-primary)] transition-transform duration-150 group-hover:translate-x-0.5"
          >
            →
          </span>
        </Link>
      ))}
    </nav>
  )
}

const fontSizePreferenceLabelKeys: Record<FontSizePreference, MessageKey> = {
  compact: 'workspace.settings.fontSize.compact',
  standard: 'workspace.settings.fontSize.standard',
  comfortable: 'workspace.settings.fontSize.comfortable',
}

function SettingsView({
  accessToken,
  canManageWorkspaceConfiguration,
  canMutateTeamConfiguration,
  fontSizePreference,
  locale,
  notificationPreferences,
  onFontSizePreferenceChange,
  onLocaleChange,
  t,
  teams,
  userLabel,
}: {
  accessToken?: string
  canManageWorkspaceConfiguration: boolean
  canMutateTeamConfiguration: boolean
  fontSizePreference: FontSizePreference
  locale: Locale
  notificationPreferences?: NotificationPreferencesController
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  onLocaleChange?: (locale: Locale) => void
  t: (key: MessageKey) => string
  teams: ProjectDirectoryTeam[]
  userLabel: string
}) {
  const location = useLocation()
  const developerPlatformLabels = useMemo(
    () => createDeveloperPlatformLabels(locale),
    [locale],
  )
  const developerImportTeamOptions = useMemo(
    () => teams.map((team) => ({
      value: team.id,
      label: team.name,
      description: team.id,
    })),
    [teams],
  )
  const developerImportProjectOptions = useMemo(() => {
    return teams.flatMap((team) =>
      team.projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: team.name,
        teamId: team.id,
      })),
    )
  }, [teams])
  const developerDateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [locale],
  )
  const developerInitialSection = useMemo(
    () => new URLSearchParams(location.search).get('developerSection') === 'connectors'
      ? 'connectors' as const
      : undefined,
    [location.search],
  )

  return (
    <div className="grid gap-5">
      <section className="workbench-panel overflow-hidden">
        <SectionHeader
          title={t('workspace.settings.displayTitle')}
          meta={t('workspace.settings.displayDescription')}
        />
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <div className="min-w-0 max-w-[640px]">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.settings.fontSizeTitle')}
              </h3>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.fontSizeDescription')}
              </p>
            </div>
            <div
              aria-label={t('workspace.settings.fontSizeTitle')}
              className="inline-flex min-h-10 overflow-hidden rounded-lg border border-[var(--workbench-border-strong)] bg-white"
              data-testid="font-size-preference-control"
              role="group"
            >
              {fontSizePreferenceOptions.map((preference) => (
                <button
                  aria-pressed={fontSizePreference === preference}
                  className={`px-4 text-sm font-semibold transition-colors duration-150 ${
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

          <label className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {t('language.aria')}
              </strong>
              <span className="mt-1 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.languageDescription')}
              </span>
            </span>
            <select
              className="workbench-input min-h-10 min-w-[168px] px-3 disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
              disabled={!onLocaleChange}
              value={locale}
              onChange={(event) => onLocaleChange?.(event.target.value === 'en' ? 'en' : 'ja')}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {notificationPreferences ? (
        <NotificationSettingsPanel
          controller={notificationPreferences}
          key={notificationPreferences.preferences?.version ?? 'notification-settings-loading'}
          locale={locale}
        />
      ) : null}
      <InfoGrid
        items={[
          ['workspace.settings.profileTitle', 'workspace.settings.profileDescription'],
          ['workspace.settings.permissionTitle', 'workspace.settings.permissionDescription'],
          ['workspace.settings.integrationTitle', 'workspace.settings.integrationDescription'],
        ]}
        t={t}
      />

      <Link
        className="workbench-panel group flex min-w-0 items-center justify-between gap-5 border-[#99d7cf] bg-[#f3fbfa] p-5 transition hover:border-[var(--workbench-primary)] hover:shadow-sm"
        data-testid="enterprise-security-settings-link"
        to="/settings/security"
      >
        <span className="min-w-0">
          <span className="workbench-eyebrow">
            {t('workspace.settings.securityEyebrow')}
          </span>
          <strong className="mt-2 block text-lg font-semibold text-[var(--workbench-text)]">
            {t('workspace.settings.securityTitle')}
          </strong>
          <span className="mt-2 block max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.settings.securityDescription')}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="grid h-11 w-11 flex-none place-items-center rounded-full border border-[#99d7cf] bg-white text-lg font-semibold text-[var(--workbench-primary)] transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </Link>

      {accessToken ? (
        <WorkspaceAccessPanelContainer accessToken={accessToken} locale={locale} />
      ) : null}

      {accessToken ? (
        <DeveloperPlatformPanelContainer
          accessToken={accessToken}
          formatDateTime={(value) => developerDateTimeFormatter.format(new Date(value))}
          initialSection={developerInitialSection}
          importProjectOptions={developerImportProjectOptions}
          importTeamOptions={developerImportTeamOptions}
          labels={developerPlatformLabels}
        />
      ) : null}

      {accessToken ? (
        <WorkItemConfigurationPanelContainer
          accessToken={accessToken}
          canManageWorkspaceConfiguration={canManageWorkspaceConfiguration}
          canMutateTeamConfiguration={canMutateTeamConfiguration}
          locale={locale}
          teams={teams}
        />
      ) : null}

      {accessToken ? (
        <AutomationManagementPanelContainer
          accessToken={accessToken}
          canManage={canManageWorkspaceConfiguration}
          locale={locale}
          teams={teams}
        />
      ) : null}

      <section className="workbench-panel p-5">
        <p className="workbench-eyebrow">{t('workspace.user.label')}</p>
        <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.profileTitle')}
        </h2>
        <p className="mt-3 break-all text-sm font-medium text-[var(--workbench-muted)]">
          {userLabel}
        </p>
      </section>
    </div>
  )
}

function createEnterpriseSecurityScopeOptions(
  teams: ProjectDirectoryTeam[],
  workspaceLabel: string,
): EnterpriseSecurityScopeOption[] {
  const projects = new Map<
    string,
    { id: string; name: string; teamName: string }
  >()

  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) {
        projects.set(project.id, {
          id: project.id,
          name: project.name,
          teamName: team.name,
        })
      }
    }
  }

  return [
    {
      id: 'workspace',
      name: workspaceLabel,
      type: 'workspace',
    },
    ...teams.map((team) => ({
      id: team.id,
      name: team.name,
      type: 'team' as const,
    })),
    ...Array.from(projects.values(), (project) => ({
      id: project.id,
      name: `${project.name} · ${project.teamName}`,
      type: 'project' as const,
    })),
  ]
}

function WorkItemConfigurationPanelContainer({
  accessToken,
  canManageWorkspaceConfiguration,
  canMutateTeamConfiguration,
  locale,
  teams,
}: {
  /** Configuration API の Authorization header に使う access token です。 */
  accessToken: string
  /** Workspace default を編集できるかどうかです。 */
  canManageWorkspaceConfiguration: boolean
  /** Team manager 権限の server 判定を受ける mutation を開始できるかどうかです。 */
  canMutateTeamConfiguration: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** Scope selector に表示する Team 一覧です。 */
  teams: ProjectDirectoryTeam[]
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [selectedScopeValue, setSelectedScopeValue] = useState('workspace')
  const selectedTeamId = selectedScopeValue.startsWith('team:')
    ? selectedScopeValue.slice('team:'.length)
    : undefined
  const selectedScope: WorkItemConfigurationScope = selectedTeamId
    ? { kind: 'team', teamId: selectedTeamId }
    : { kind: 'workspace' }
  const scopeOptions = useMemo<WorkItemConfigurationScopeOption[]>(() => [
    {
      description: t('workItems.configuration.scopeWorkspaceDescription'),
      label: t('workItems.configuration.scopeWorkspace'),
      value: 'workspace',
    },
    ...teams.map((team) => ({
      description: t('workItems.configuration.scopeTeamDescription').replace('{team}', team.name),
      label: t('workItems.configuration.scopeTeam').replace('{team}', team.name),
      value: `team:${team.id}`,
    })),
  ], [t, teams])
  const {
    data: resolvedConfiguration,
    error,
    isLoading,
    mutate,
  } = useScopedWorkItemConfiguration(accessToken, selectedScope)
  const readOnly = selectedScope.kind === 'workspace'
    ? !canManageWorkspaceConfiguration
    : !canMutateTeamConfiguration

  const handleSave = async (configuration: WorkItemConfiguration) => {
    const isCreatingTeamOverride =
      selectedScope.kind === 'team' && Boolean(resolvedConfiguration?.inheritedFrom)
    const payload: WorkItemConfiguration = {
      ...configuration,
      revision: isCreatingTeamOverride ? 0 : configuration.revision,
      scopeId: selectedScope.kind === 'team'
        ? selectedScope.teamId
        : configuration.scopeId,
      scopeType: selectedScope.kind,
      ...(isCreatingTeamOverride ? { updatedAt: undefined } : {}),
    }
    const saved = await mutationRequestRunner.run(
      `work-item-configuration:${selectedScopeValue}`,
      JSON.stringify(payload),
      (context) => putWorkItemConfiguration(
        accessToken,
        selectedScope,
        payload,
        context,
      ),
    )
    await mutate(saved, { revalidate: false })
  }

  return (
    <WorkItemConfigurationPanel
      configuration={resolvedConfiguration?.configuration}
      errorMessage={error instanceof Error ? error.message : undefined}
      inheritedFrom={resolvedConfiguration?.inheritedFrom}
      isLoading={isLoading}
      locale={locale}
      readOnly={readOnly}
      scopeOptions={scopeOptions}
      selectedScopeValue={selectedScopeValue}
      onSave={readOnly ? undefined : handleSave}
      onScopeChange={setSelectedScopeValue}
    />
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
  workItemConfigurationsByTeam,
}: {
  isTeamProjectMembersLoading: boolean
  onOpenTask?: (task: ProjectTask) => void
  onSelectProject?: (projectId: string, teamId: string) => void
  team?: ProjectDirectoryTeam
  teamProjectMembers: TeamProjectMemberAccess[]
  teamProjectMembersFailedProjectIds: string[]
  t: (key: MessageKey) => string
  tasks: ProjectTask[]
  workItemConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
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
          value={teamTasks.filter((task) => isOpenWorkItem(task)).length}
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
                      <ProgressBar
                        label={`${project.name} ${t('workspace.teamOverview.column.progress')}`}
                        value={project.progress}
                      />
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
                          {project.nextTask.dueDate} / {resolveWorkItemWorkflowStatusLabel(
                            project.nextTask,
                            resolveWorkspaceTaskConfiguration(
                              project.nextTask,
                              workItemConfigurationsByTeam,
                            ),
                          )}
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
  const members = createTeamMemberRows(projects, tasks, teamProjectMembers, team?.id)
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
  const openTaskCount = members.reduce((total, member) => total + member.openTaskCount, 0)
  const attentionTaskCount = members.reduce(
    (total, member) => total + member.attentionTaskCount,
    0,
  )

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.members.metric.members')} value={members.length} tone="teal" />
        <MetricCard label={t('workspace.members.metric.managers')} value={managerCount} tone="amber" />
        <MetricCard label={t('workspace.reports.metric.attention')} value={attentionTaskCount} tone="red" />
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
                    {t('workspace.members.metric.open')}
                  </p>
                  <p className="text-sm font-semibold text-[#0d1833]">{member.openPercent}%</p>
                </div>
                <ProgressBar
                  label={`${member.name} ${t('workspace.members.metric.open')}`}
                  value={member.openPercent}
                />
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
  configuration,
  onOpenTask,
  t,
  task,
}: {
  configuration?: WorkItemConfiguration
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
      <StatusPill configuration={configuration} task={task} />
      <span className="text-[var(--workbench-muted)]">{task.dueDate}</span>
      <span className="workbench-badge justify-self-end max-[900px]:justify-self-start">
        {t('workspace.action.openTask')}
      </span>
    </button>
  )
}

function CompactTaskCard({
  configuration,
  draggable = false,
  isDragging = false,
  isMoving = false,
  onDragEnd,
  onDragStart,
  onOpenTask,
  onStatusChange,
  t,
  task,
  testId,
  workflowStatuses = [],
}: {
  configuration?: WorkItemConfiguration
  draggable?: boolean
  isDragging?: boolean
  isMoving?: boolean
  onDragEnd?: () => void
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onOpenTask?: (task: ProjectTask) => void
  onStatusChange?: (workflowStatusId: string) => void
  t: (key: MessageKey) => string
  task: ProjectTask
  testId?: string
  workflowStatuses?: readonly WorkflowStatusDefinition[]
}) {
  const taskTitle = resolveTaskTitle(task, t)
  const statusSelectLabel = t('workspace.myTasks.moveStatusLabel').replace(
    '{title}',
    taskTitle,
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
      {onOpenTask ? (
        <button
          className="w-full text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] hover:text-[var(--workbench-primary)] disabled:hover:text-[var(--workbench-text)]"
          data-testid={testId ? `${testId}-open` : undefined}
          disabled={!isOpenableWorkspaceTask(task)}
          onClick={() => onOpenTask(task)}
          type="button"
        >
          {taskTitle}
        </button>
      ) : (
        <p className="text-sm font-semibold leading-6 text-[var(--workbench-text)]">{taskTitle}</p>
      )}
      <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{task.dueDate}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill configuration={configuration} task={task} />
        <PriorityPill priority={task.priority} t={t} />
      </div>
      {onStatusChange ? (
        <select
          aria-label={statusSelectLabel}
          className="workbench-input mt-3 h-9 w-full px-3 text-xs disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          data-testid={testId ? `${testId}-status-select` : undefined}
          disabled={isMoving}
          value={resolveWorkItemWorkflowStatusId(task)}
          onChange={(event) => {
            const nextStatus = workflowStatuses.find(
              (status) => status.id === event.target.value,
            )

            if (nextStatus) {
              onStatusChange(nextStatus.id)
            }
          }}
        >
          {workflowStatuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  )
}

function StatusPill({
  configuration,
  task,
}: {
  configuration?: WorkItemConfiguration
  task: ProjectTask
}) {
  return (
    <span className={resolveWorkflowCategoryToneClassName(resolveWorkflowStatusCategory(task))}>
      {resolveWorkItemWorkflowStatusLabel(task, configuration)}
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

/**
 * 集計値を百分率で示す進捗バーの props です。
 */
type ProgressBarProps = {
  /**
   * 進捗バーが表す対象のアクセシブルネームです。
   */
  label: string
  /**
   * 0 から 100 の範囲へ補正して表示する進捗値です。
   */
  value: number
}

function ProgressBar({ label, value }: ProgressBarProps) {
  const normalizedValue = Math.max(0, Math.min(100, value))

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={normalizedValue}
      aria-valuetext={`${normalizedValue}%`}
      className="h-2 overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
    >
      <div
        aria-hidden="true"
        className="h-full rounded-full bg-[var(--workbench-primary)]"
        style={{ width: `${normalizedValue}%` }}
      />
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

function uniqueProjectIds(teams: ProjectDirectoryTeam[]) {
  return Array.from(
    new Set(teams.flatMap((team) => team.projects.map((project) => project.id))),
  )
}

function createWorkspaceTaskKey(task: ProjectTask) {
  return `${task.teamId}:${task.assignedProjectId ?? ''}:${task.id}`
}

function resolveWorkspaceTaskConfiguration(
  task: ProjectTask,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
) {
  return configurationsByTeam[task.teamId]?.configuration
}

function createWorkspaceTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(`${task.assignedProjectId ?? 'unassigned'}:${task.id}`)
}

function createInboxTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(
    `${task.teamId}:${task.assignedProjectId ?? 'unassigned'}:${task.id}`,
  )
}

function createWorkspaceTaskTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function findWorkspaceTaskByKey(tasks: ProjectTask[], taskKey: string) {
  return tasks.find((task) => createWorkspaceTaskKey(task) === taskKey)
}

function updateWorkspaceTaskStatus(
  tasks: ProjectTask[],
  targetTask: ProjectTask,
  status: WorkflowStatusDefinition,
  expectedCurrentStatusId?: string,
) {
  const targetTaskKey = createWorkspaceTaskKey(targetTask)

  return tasks.map((task): ProjectTask =>
    createWorkspaceTaskKey(task) === targetTaskKey &&
    (expectedCurrentStatusId === undefined || task.workflowStatusId === expectedCurrentStatusId)
      ? {
          ...task,
          statusCategory: status.category,
          workflowStatusId: status.id,
        }
      : task,
  )
}

function createWorkspaceTaskStatusColumns(
  tasks: readonly ProjectTask[],
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>,
  teams: readonly ProjectDirectoryTeam[],
): WorkspaceTaskStatusColumn[] {
  const taskTeamIds = Array.from(new Set(tasks.map((task) => task.teamId))).sort()
  const showTeamName = taskTeamIds.length > 1
  return taskTeamIds.flatMap((teamId) => {
    const configuration = configurationsByTeam[teamId]?.configuration

    if (!configuration) {
      return []
    }

    const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId

    return [...configuration.workflow.statuses]
      .sort((first, second) =>
        first.sortOrder - second.sortOrder || first.name.localeCompare(second.name)
      )
      .map((status) => ({
        key: `${teamId}:${status.id}`,
        label: showTeamName ? `${teamName} · ${status.name}` : status.name,
        status,
        teamId,
      }))
  })
}

function isTaskInWorkspaceStatusColumn(
  task: ProjectTask,
  column: WorkspaceTaskStatusColumn,
) {
  return column.teamId === task.teamId && column.status.id === task.workflowStatusId
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

  return tasks.filter((task) => Boolean(
    task.assignedProjectId && projectIdSet.has(task.assignedProjectId),
  ))
}

function filterTasksByTeamProjectIds(
  tasks: ProjectTask[],
  projectIds: readonly string[],
  teamId?: string,
) {
  return filterTasksByProjectIds(tasks, projectIds).filter(
    (task) => !teamId || !task.teamId || task.teamId === teamId,
  )
}

function createDashboardSummary(
  teams: ProjectDirectoryTeam[],
  tasks: ProjectTask[],
): DashboardSummary {
  return {
    projects: uniqueProjectIds(teams).length,
    tasks: tasks.filter((task) => isOpenWorkItem(task)).length,
    blocked: tasks.filter((task) => task.priority === 'high' && isOpenWorkItem(task)).length,
    updatedAt: new Date().toISOString(),
    source: 'dynamodb',
  }
}

function resolveTaskTitle(task: ProjectTask, t: (key: MessageKey) => string) {
  void t
  return resolveWorkItemTitle(task)
}

function resolveTaskAssignee(task: ProjectTask, t: (key: MessageKey) => string) {
  void t
  return resolveWorkItemAssignee(task)
}

function createActionQueueTasks(tasks: ProjectTask[]) {
  return [...tasks]
    .filter((task) => isOpenWorkItem(task) || hasApprovalAttention(task))
    .sort((firstTask, secondTask) => {
      const firstScore = calculateWorkspaceActionScore(firstTask)
      const secondScore = calculateWorkspaceActionScore(secondTask)

      if (firstScore !== secondScore) {
        return secondScore - firstScore
      }

      return getWorkspaceDueTime(firstTask) - getWorkspaceDueTime(secondTask)
    })
}

function isWorkspaceTaskInReview(task: ProjectTask) {
  return resolveWorkItemWorkflowStatusId(task) === 'review'
}

function createInboxTasks(tasks: ProjectTask[]) {
  return createActionQueueTasks(tasks)
    .filter((task) =>
      task.priority === 'high' ||
      isWorkspaceTaskInReview(task) ||
      isWorkspaceTaskOverdue(task) ||
      hasApprovalAttention(task),
    )
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
  const scopedProject = scopedTeam?.projects.find((project) => project.id === task.assignedProjectId)

  if (scopedProject) {
    return scopedProject.name
  }

  return teams
    .flatMap((team) => team.projects)
    .find((project) => project.id === task.assignedProjectId)?.name ??
      task.assignedProjectId ??
      '-'
}

function createInboxReasonKeys(task: ProjectTask): MessageKey[] {
  const reasonKeys: MessageKey[] = []

  if (isWorkspaceTaskOverdue(task)) {
    reasonKeys.push('workspace.inbox.reason.overdue')
  }

  if (task.priority === 'high') {
    reasonKeys.push('workspace.inbox.reason.high')
  }

  if (isWorkspaceTaskInReview(task)) {
    reasonKeys.push('workspace.inbox.reason.review')
  }

  if (task.approvalSummary?.overdueCount) {
    reasonKeys.push('workspace.inbox.reason.approvalOverdue')
  } else if (hasApprovalAttention(task)) {
    reasonKeys.push('workspace.inbox.reason.approval')
  }

  return reasonKeys.length > 0 ? reasonKeys : ['workspace.inbox.reason.watch']
}

function resolveInboxReasonClassName(reasonKey: MessageKey) {
  if (
    reasonKey === 'workspace.inbox.reason.overdue' ||
    reasonKey === 'workspace.inbox.reason.high' ||
    reasonKey === 'workspace.inbox.reason.approvalOverdue'
  ) {
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
    ((task.approvalSummary?.overdueCount ?? 0) > 0 ? 8 : 0) +
    (hasApprovalAttention(task) ? 4 : 0) +
    (task.priority === 'high' ? 5 : task.priority === 'medium' ? 2 : 0) +
    (isWorkspaceTaskInReview(task) ? 4 : 0)
}

function isOpenableWorkspaceTask(task: ProjectTask) {
  return Boolean(task.teamId)
}

function hasApprovalAttention(task: ProjectTask) {
  const summary = task.approvalSummary

  return Boolean(summary && (
    summary.pendingCount > 0 ||
    summary.overdueCount > 0
  ))
}

function isWorkspaceTaskOverdue(task: ProjectTask) {
  const dueDate = parseWorkspaceTaskDueDate(task.dueDate)

  if (!isOpenWorkItem(task) || !dueDate) {
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

  return Math.round((tasks.filter((task) => isCompletedWorkItem(task)).length / tasks.length) * 100)
}

function resolvePortfolioRiskKey(tasks: ProjectTask[]): MessageKey {
  if (tasks.some((task) => task.priority === 'high' && isOpenWorkItem(task))) {
    return 'workspace.risk.watch'
  }

  if (tasks.every((task) => isCompletedWorkItem(task))) {
    return 'workspace.risk.low'
  }

  return 'workspace.risk.clear'
}

function createReportProjectRows(teams: ProjectDirectoryTeam[], tasks: ProjectTask[]) {
  return teams
    .flatMap((team) => team.projects.map((project) => {
      const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], team.id)
      const openTaskCount = projectTasks.filter((task) => isOpenWorkItem(task)).length
      const doneTaskCount = projectTasks.filter((task) => isCompletedWorkItem(task)).length
      const reviewTaskCount = projectTasks.filter(
        isWorkspaceTaskInReview,
      ).length
      const attentionTaskCount = createInboxTasks(projectTasks).length
      const pendingApprovalCount = projectTasks.reduce(
        (count, task) => count + (task.approvalSummary?.pendingCount ?? 0),
        0,
      )
      const overdueApprovalCount = projectTasks.reduce(
        (count, task) => count + (task.approvalSummary?.overdueCount ?? 0),
        0,
      )

      return {
        attentionTaskCount,
        doneTaskCount,
        name: project.name,
        openTaskCount,
        overdueApprovalCount,
        pendingApprovalCount,
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

function resolveReportStatusToneClassName(category: WorkflowStatusCategory) {
  const toneClassNames: Record<WorkflowStatusCategory, string> = {
    backlog: 'bg-slate-400',
    unstarted: 'bg-slate-500',
    started: 'bg-[var(--workbench-primary)]',
    completed: 'bg-emerald-600',
    canceled: 'bg-red-600',
  }

  return toneClassNames[category]
}

function resolveReportPriorityToneClassName(priority: TaskPriority) {
  const toneClassNames: Record<TaskPriority, string> = {
    high: 'bg-red-600',
    medium: 'bg-amber-500',
    low: 'bg-emerald-600',
  }

  return toneClassNames[priority]
}

function formatReportCustomFieldValue(
  task: ProjectTask,
  definition: CustomFieldDefinition,
  locale: Locale,
) {
  const t = createTranslator(locale)

  return formatWorkItemCustomFieldValue(task, definition, {
    durationUnitLabels: {
      days: t('workItems.durationUnit.days'),
      hours: t('workItems.durationUnit.hours'),
      minutes: t('workItems.durationUnit.minutes'),
    },
    emptyLabel: '',
    falseLabel: t('workItems.fields.booleanFalse'),
    locale,
    trueLabel: t('workItems.fields.booleanTrue'),
  })
}

function createCustomFieldDistribution(
  tasks: readonly ProjectTask[],
  definition: CustomFieldDefinition,
  locale: Locale,
) {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const label = formatReportCustomFieldValue(task, definition, locale)
    if (!label) {
      continue
    }
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label))
    .slice(0, 8)
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
    t('workspace.reports.column.pendingApprovals'),
    t('workspace.reports.column.overdueApprovals'),
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
    project.pendingApprovalCount,
    project.overdueApprovalCount,
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
      openTaskCount: projectTasks.filter((task) => isOpenWorkItem(task)).length,
      progress: calculateProjectProgress(projectTasks),
      reviewTaskCount: projectTasks.filter(
        isWorkspaceTaskInReview,
      ).length,
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
    const memberId = resolveTaskMemberId(task, memberAliases)
    const row = memberId ? rowsByMemberId.get(memberId) : undefined

    if (
      !row ||
      !task.assignedProjectId ||
      !row.projectAccess.some((project) => project.projectId === task.assignedProjectId)
    ) {
      continue
    }

    tasksByMemberId.set(row.id, [...(tasksByMemberId.get(row.id) ?? []), task])
  }

  return Array.from(rowsByMemberId.values())
    .map((row) => {
      const memberTasks = tasksByMemberId.get(row.id) ?? []
      const openTasks = memberTasks.filter((task) => isOpenWorkItem(task))
      const openTaskCount = openTasks.length
      const nextDueDate = openTasks
        .map((task) => task.dueDate)
        .sort((firstDate, secondDate) => firstDate.localeCompare(secondDate))[0]

      return {
        ...row,
        attentionTaskCount: memberTasks.filter(isAttentionWorkspaceTask).length,
        openPercent: Math.round((openTaskCount / Math.max(1, memberTasks.length)) * 100),
        nextDueDate,
        openTaskCount,
        projectAccess: row.projectAccess.sort(
          (firstProject, secondProject) =>
            (projectOrder.get(firstProject.projectId) ?? Number.MAX_SAFE_INTEGER) -
              (projectOrder.get(secondProject.projectId) ?? Number.MAX_SAFE_INTEGER) ||
            firstProject.projectName.localeCompare(secondProject.projectName),
        ),
        reviewTaskCount: memberTasks.filter(
          isWorkspaceTaskInReview,
        ).length,
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
    openPercent: 0,
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
) {
  const taskAliases = [
    task.assigneeUserId,
    task.assigneeEmail,
    task.assigneeName,
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
  return isOpenWorkItem(task) && (task.priority === 'high' || isWorkspaceTaskOverdue(task))
}

function formatTeamText(value: string, teamName?: string) {
  return value.replace('{team}', teamName ?? '')
}
