import type { DashboardSummary } from '../../auth/api'
import type { SidebarNavId, SidebarTeamViewId } from '../../shared/ui/sidebar'
import type { Locale } from '../../shared/i18n/i18n'
import type { InboxNotification } from '../../notifications/api'
import type {
  NotificationInboxController,
  NotificationPreferencesController,
} from '../../notifications/mutations/useNotifications'
import type {
  CreateProjectDirectoryProjectInput,
  CreateProjectDirectoryTeamInput,
  ProjectDirectoryTeam,
  ProjectMember,
  ProjectMemberRole,
} from '../../projects/api'
import type { FontSizePreference } from '../../shared/lib/preferences/fontSize'
import type { ProjectTask, TaskStatus } from '../../tasks/api'

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
 * チーム配下プロジェクトから取得した project member の所属情報です。
 */
export type TeamProjectMemberAccess = {
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
export type TeamProjectMembersResult = {
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
export type TeamProjectSummary = {
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
export type TeamMemberRoleFilter = ProjectMemberRole | 'all'

/**
 * チームメンバーが参加しているプロジェクトとロールです。
 */
export type TeamMemberProjectAccess = {
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
export type TeamMemberRow = {
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
export type WorkspaceScreenProps = {
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
   * チーム画面で選択中のチーム ID です。
   */
  activeTeamId?: string
  /**
   * 表示に使うタスク一覧です。
   */
  tasks: ProjectTask[]
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
  onMoveTaskStatus?: (task: ProjectTask, status: TaskStatus) => Promise<void>
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
