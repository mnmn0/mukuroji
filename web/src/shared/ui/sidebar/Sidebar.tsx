import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentType, FormEvent, ReactNode, RefObject } from 'react'
import { BrandMark } from '../BrandMark'

/**
 * サイドバー内の SVG アイコンに渡す共通 props です。
 */
type SidebarIconProps = {
  /**
   * アイコンに適用する CSS class です。
   */
  className?: string
}

/**
 * サイドバー上のプロジェクトを識別しやすくする表示色です。
 */
export type SidebarProjectTone = 'blue' | 'purple' | 'green' | 'yellow'

/**
 * サイドバーに表示するプロジェクトです。
 */
export type SidebarProject = {
  /**
   * プロジェクトの一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するプロジェクト名です。
   */
  name: string
  /**
   * プロジェクトアイコンの表示色です。
   */
  tone?: SidebarProjectTone
}

/** Project shortcut resolved with the Team context required for a stable deep link. */
export type SidebarQuickAccessProject = {
  /** Project ID represented by this shortcut. */
  projectId: string
  /** Current Project display name. */
  name: string
  /** Current Project display tone. */
  tone?: SidebarProjectTone
  /** ID of the Team used when opening the Project. */
  teamId: string
  /** Team label shown when managing shortcuts. */
  teamName: string
}

/**
 * サイドバーに表示するチームです。
 */
export type SidebarTeam = {
  /**
   * チームの一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するチーム名です。
   */
  name: string
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded?: boolean
  /**
   * チームに紐づくプロジェクト一覧です。
   */
  projects?: SidebarProject[]
}

/**
 * サイドバーの主要ナビゲーション項目です。
 */
export type SidebarNavId =
  | 'home'
  | 'focus'
  | 'my-tasks'
  | 'inbox'
  | 'requests'
  | 'documents'
  | 'dashboard'
  | 'planning'
  | 'reports'
  | 'help'
  | 'settings'

/**
 * チーム配下で選択できる固定ビューです。
 */
export type SidebarTeamViewId = 'overview' | 'issues' | 'projects' | 'members'

/**
 * 新規作成モーダルで選択できる作成対象です。
 */
type SidebarCreateMode = 'team' | 'project'

/**
 * 新規登録モーダルで使う表示文言です。
 */
export type SidebarCreateLabels = {
  /**
   * 新規登録モーダルの見出しです。
   */
  title: string
  /**
   * 新規登録モーダルを閉じるボタンの文言です。
   */
  close: string
  /**
   * チーム作成タブの文言です。
   */
  teamMode: string
  /**
   * プロジェクト作成タブの文言です。
   */
  projectMode: string
  /**
   * チーム名入力のラベルです。
   */
  teamName: string
  /**
   * チーム名入力の placeholder です。
   */
  teamPlaceholder: string
  /**
   * プロジェクト名入力のラベルです。
   */
  projectName: string
  /**
   * プロジェクト名入力の placeholder です。
   */
  projectPlaceholder: string
  /**
   * プロジェクト登録先チーム選択のラベルです。
   */
  team: string
  /**
   * プロジェクト色選択のラベルです。
   */
  tone: string
  /**
   * プロジェクト色ごとの表示名です。
   */
  toneLabels: Record<SidebarProjectTone, string>
  /**
   * チーム登録ボタンの文言です。
   */
  createTeam: string
  /**
   * プロジェクト登録ボタンの文言です。
   */
  createProject: string
  /**
   * 保存中のボタン文言です。
   */
  saving: string
  /**
   * チーム名未入力時のエラーメッセージです。
   */
  teamNameRequired: string
  /**
   * プロジェクト名未入力時のエラーメッセージです。
   */
  projectNameRequired: string
  /**
   * 登録失敗時の汎用エラーメッセージです。
   */
  error: string
  /**
   * チーム/プロジェクト API 由来のエラーメッセージです。
   */
  loadingError: string
  /**
   * 登録先チームがない場合のメッセージです。
   */
  noTeams: string
}

/**
 * サイドバー内のアーカイブ操作で使う表示文言です。
 */
export type SidebarArchiveLabels = {
  /**
   * チームアーカイブボタンのアクセシブルラベルを返します。
   */
  team: (name: string) => string
  /**
   * プロジェクトアーカイブボタンのアクセシブルラベルを返します。
   */
  project: (name: string) => string
  /**
   * アーカイブ処理中のアクセシブルラベルです。
   */
  archiving: string
  /**
   * アーカイブ失敗時のエラーメッセージです。
   */
  error: string
  /**
   * アーカイブ確認 dialog の見出しです。
   */
  confirmTitle: string
  /**
   * チーム名と配下への影響を含む確認文を返します。
   */
  confirmTeamDescription: (name: string) => string
  /**
   * プロジェクト名と復元制約を含む確認文を返します。
   */
  confirmProjectDescription: (name: string) => string
  /**
   * 確認 dialog のキャンセルボタンです。
   */
  cancel: string
  /**
   * 確認 dialog の実行ボタンです。
   */
  confirm: string
}

/**
 * サイドバーで使う表示文言です。
 */
export type SidebarLabels = {
  /**
   * サイドバー全体の aria-label です。
   */
  ariaLabel: string
  /**
   * 主要ナビゲーションの aria-label です。
   */
  globalNavigation: string
  /**
   * 補助ナビゲーションの aria-label です。
   */
  utilityNavigation: string
  /**
   * 折りたたみボタンの文言です。
   */
  collapse: string
  /**
   * 展開ボタンの文言です。
   */
  expand: string
  /**
   * Workspace search と command menu を開く操作の文言です。
   */
  search: string
  /**
   * Workspace search の keyboard shortcut 表示です。
   */
  searchShortcut: string
  /** Quick Access section heading. */
  quickAccess: string
  /** Accessible label for opening Quick Access management. */
  manageQuickAccess: string
  /** Empty state shown before any Project is starred. */
  quickAccessEmpty: string
  /** Link label used when more than five shortcuts exist. */
  showAllQuickAccess: string
  /** Heading for the Quick Access management dialog. */
  quickAccessDialogTitle: string
  /** Supporting copy for the Quick Access management dialog. */
  quickAccessDialogDescription: string
  /** Accessible label for closing the Quick Access management dialog. */
  closeQuickAccessDialog: string
  /** Moves a shortcut one position earlier. */
  moveQuickAccessUp: string
  /** Moves a shortcut one position later. */
  moveQuickAccessDown: string
  /** Removes a shortcut from Quick Access. */
  removeQuickAccess: string
  /** Current Team section heading. */
  currentTeam: string
  /** Accessible label for opening the Team switcher. */
  switchTeam: string
  /** Placeholder and label for Team filtering. */
  searchTeams: string
  /** Empty state for a Team search with no results. */
  noTeamsFound: string
  /** Label for the less frequently used navigation menu. */
  more: string
  /** Label for opening the Workspace-wide Project directory. */
  allProjects: string
  /**
   * チーム / プロジェクト見出しの文言です。
   */
  teamProjects: string
  /**
   * チーム作成ボタンの文言です。
   */
  createTeam: string
  /**
   * チーム/プロジェクト新規登録モーダルの文言です。
   */
  create: SidebarCreateLabels
  /**
   * チーム/プロジェクトのアーカイブ操作の文言です。
   */
  archive: SidebarArchiveLabels
  /**
   * チーム概要ビューの文言です。
   */
  teamOverview: string
  /**
   * Issue ビューの文言です。
   */
  issues: string
  /**
   * メンバービューの文言です。
   */
  members: string
  /** Project index view label including the Team Project count. */
  projectCount: (count: number) => string
  /**
   * プロジェクト一覧見出しの文言です。
   */
  projectGroup: string
  /**
   * 未読件数のアクセシブルラベルを返します。
   */
  unreadCount: (count: number) => string
  /**
   * 固定ナビゲーション項目ごとの文言です。
   */
  nav: Record<SidebarNavId, string>
}

/**
 * サイドバーコンポーネントの入力プロパティです。
 */
export type SidebarProps = {
  /**
   * ワークスペース名です。
   */
  workspaceName?: string
  /**
   * 既定文言を上書きする文言です。
   */
  labels?: PartialSidebarLabels
  /**
   * 制御された現在の主要ナビゲーション ID です。
   */
  activeNavId?: SidebarNavId
  /**
   * 非制御時に初期選択する主要ナビゲーション ID です。
   */
  defaultActiveNavId?: SidebarNavId
  /**
   * 制御された現在のチーム固定ビュー ID です。
   */
  activeTeamViewId?: SidebarTeamViewId
  /**
   * 非制御時に初期選択するチーム固定ビュー ID です。
   */
  defaultActiveTeamViewId?: SidebarTeamViewId
  /**
   * 制御された現在のチーム ID です。
   */
  activeTeamId?: string
  /**
   * 非制御時に初期選択するチーム ID です。
   */
  defaultActiveTeamId?: string
  /**
   * 制御された現在のプロジェクト ID です。
   */
  activeProjectId?: string
  /**
   * 制御された現在のプロジェクトが選択されたチーム ID です。
   * 複数 Team を横断する aggregate 表示では null を指定します。
   */
  activeProjectTeamId?: string | null
  /**
   * 非制御時に初期選択するプロジェクト ID です。
   */
  defaultActiveProjectId?: string
  /**
   * 非制御時に初期選択するプロジェクトが所属するチーム ID です。
   */
  defaultActiveProjectTeamId?: string
  /**
   * 制御された展開中チーム ID 一覧です。
   */
  expandedTeamIds?: string[]
  /**
   * 非制御時に初期展開するチーム ID 一覧です。
   */
  defaultExpandedTeamIds?: string[]
  /**
   * 制御された折りたたみ状態です。
   */
  collapsed?: boolean
  /**
   * 非制御時の初期折りたたみ状態です。
   */
  defaultCollapsed?: boolean
  /**
   * 非制御時に初期表示で新規登録モーダルを開くかどうかです。
   */
  defaultCreatePanelOpen?: boolean
  /** Non-controlled initial state for the Quick Access management dialog. */
  defaultQuickAccessManagerOpen?: boolean
  /** Whether an uncontrolled sidebar should select its first Project initially. */
  autoSelectInitialProject?: boolean
  /**
   * 受信箱の未読件数です。
   */
  inboxCount?: number
  /**
   * サイドバーに表示するチーム一覧です。
   */
  teams: SidebarTeam[]
  /** Ordered Project shortcuts already resolved against the readable directory. */
  quickAccessProjects?: SidebarQuickAccessProject[]
  /** Whether a Quick Access preference replacement is in progress. */
  isQuickAccessSaving?: boolean
  /** Whether the Workspace-wide Project directory is the current route. */
  isAllProjectsActive?: boolean
  /**
   * ルート要素へ追加する CSS class です。
   */
  className?: string
  /**
   * 折りたたみ状態が変わったときに呼ばれます。
   */
  onCollapsedChange?: (collapsed: boolean) => void
  /**
   * Workspace search または command menu を開くときに呼ばれます。
   */
  onOpenSearch?: () => void
  /**
   * チーム新規登録時に呼ばれます。
   */
  onCreateTeam?: (input: { name: string }) => void | Promise<void>
  /**
   * プロジェクト新規登録時に呼ばれます。
   */
  onCreateProject?: (
    teamId: string,
    input: { name: string; tone: SidebarProjectTone },
  ) => void | Promise<void>
  /**
   * チームをアーカイブするときに呼ばれます。
   */
  onArchiveTeam?: (teamId: string) => void | Promise<void>
  /**
   * プロジェクトをアーカイブするときに呼ばれます。
   */
  onArchiveProject?: (teamId: string, projectId: string) => void | Promise<void>
  /**
   * 主要ナビゲーションが選択されたときに呼ばれます。
   */
  onSelectNav?: (navId: SidebarNavId) => void
  /**
   * チーム固定ビューが選択されたときに呼ばれます。
   */
  onSelectTeamView?: (teamId: string, viewId: SidebarTeamViewId) => void
  /**
   * プロジェクトが選択されたときに呼ばれます。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
  /** Opens the complete Project index limited to Quick Access. */
  onShowAllQuickAccess?: () => void
  /** Opens the complete Workspace-wide Project directory. */
  onShowAllProjects?: () => void
  /** Moves a quick-access Project by one position. */
  onMoveQuickAccessProject?: (
    project: SidebarQuickAccessProject,
    direction: 'up' | 'down',
  ) => void | Promise<void>
  /** Removes a Project from Quick Access. */
  onRemoveQuickAccessProject?: (
    projectId: string,
    teamId: string,
    projectName: string,
  ) => void | Promise<void>
  /**
   * 展開中チーム ID 一覧が変わったときに呼ばれます。
   */
  onExpandedTeamIdsChange?: (teamIds: string[]) => void
}

/**
 * 固定ナビゲーション項目の定義です。
 */
type MainNavItem = {
  /**
   * 固定ナビゲーション項目の ID です。
   */
  id: SidebarNavId
  /**
   * ナビゲーションに表示するアイコンです。
   */
  icon: ComponentType<SidebarIconProps>
  /**
   * 任意で表示するバッジ数です。
   */
  badge?: number
}

/**
 * アーカイブ確認 dialog で保持する対象です。
 */
type SidebarArchiveTarget = {
  /**
   * チームかプロジェクトかを識別する種別です。
   */
  kind: 'team' | 'project'
  /**
   * 確認文に表示する対象名です。
   */
  name: string
  /**
   * 対象が所属するチーム ID です。
   */
  teamId: string
  /**
   * プロジェクトを対象とする場合のプロジェクト ID です。
   */
  projectId?: string
}

const primaryNavItems: MainNavItem[] = [
  { id: 'home', icon: HomeIcon },
  { id: 'focus', icon: FocusIcon },
  { id: 'my-tasks', icon: CheckCircleIcon },
  { id: 'inbox', icon: BellIcon },
  { id: 'requests', icon: PanelIcon },
]

const secondaryNavItems: MainNavItem[] = [
  { id: 'documents', icon: DocumentIcon },
  { id: 'dashboard', icon: DashboardIcon },
  { id: 'planning', icon: PlanningIcon },
  { id: 'reports', icon: ReportIcon },
]

const utilityNavItems: MainNavItem[] = [
  { id: 'help', icon: HelpCircleIcon },
  { id: 'settings', icon: SettingsIcon },
]

const defaultLabels: SidebarLabels = {
  ariaLabel: 'メインサイドバー',
  globalNavigation: 'グローバルナビゲーション',
  utilityNavigation: '補助ナビゲーション',
  collapse: 'サイドバーを折りたたむ',
  expand: 'サイドバーを展開する',
  search: 'Workspace を検索',
  searchShortcut: 'Ctrl/⌘ K',
  quickAccess: 'クイックアクセス',
  manageQuickAccess: 'クイックアクセスを管理',
  quickAccessEmpty: 'プロジェクトの星から追加できます',
  showAllQuickAccess: 'すべて表示',
  quickAccessDialogTitle: 'クイックアクセスを管理',
  quickAccessDialogDescription: '表示順の変更や削除ができます。',
  closeQuickAccessDialog: '閉じる',
  moveQuickAccessUp: '上へ移動',
  moveQuickAccessDown: '下へ移動',
  removeQuickAccess: 'クイックアクセスから削除',
  currentTeam: '現在のチーム',
  switchTeam: 'チームを切り替える',
  searchTeams: 'チームを検索',
  noTeamsFound: '一致するチームがありません',
  more: 'その他',
  allProjects: 'すべてのプロジェクト',
  teamProjects: 'チーム / プロジェクト',
  createTeam: 'チームを追加',
  create: {
    title: '新規登録',
    close: '閉じる',
    teamMode: 'チーム',
    projectMode: 'プロジェクト',
    teamName: 'チーム名',
    teamPlaceholder: '例: カスタマーサクセス',
    projectName: 'プロジェクト名',
    projectPlaceholder: '例: 導入改善',
    team: '登録先チーム',
    tone: '色',
    toneLabels: {
      blue: 'ティール',
      purple: 'ニュートラル',
      green: '緑',
      yellow: '黄',
    },
    createTeam: 'チームを登録',
    createProject: 'プロジェクトを登録',
    saving: '登録中',
    teamNameRequired: 'チーム名を入力してください。',
    projectNameRequired: 'プロジェクト名を入力してください。',
    error: '登録できませんでした',
    loadingError: 'チームとプロジェクトを取得できませんでした',
    noTeams: '先にチームを登録してください。',
  },
  archive: {
    team: (name) => `${name} をアーカイブ`,
    project: (name) => `${name} をアーカイブ`,
    archiving: 'アーカイブ中',
    error: 'アーカイブできませんでした',
    confirmTitle: 'アーカイブの確認',
    confirmTeamDescription: (name) =>
      `${name} と配下のプロジェクトをアーカイブし、サイドバーから非表示にします。現在この画面からは復元できません。`,
    confirmProjectDescription: (name) =>
      `${name} をアーカイブし、サイドバーから非表示にします。現在この画面からは復元できません。`,
    cancel: 'キャンセル',
    confirm: 'アーカイブ',
  },
  teamOverview: 'チーム概要',
  issues: 'Issues',
  members: 'メンバー',
  projectCount: (count) => `プロジェクト ${count}`,
  projectGroup: 'プロジェクト',
  unreadCount: (count) => `${count}件の未読`,
  nav: {
    home: 'ホーム',
    focus: 'フォーカス',
    'my-tasks': 'マイタスク',
    inbox: '受信箱',
    requests: 'リクエスト',
    documents: 'ドキュメント',
    dashboard: 'ダッシュボード',
    planning: 'プランニング',
    reports: 'レポート',
    help: 'ヘルプ',
    settings: '設定',
  },
}

/**
 * 既定のサイドバー文言を部分的に上書きする入力です。
 */
type PartialSidebarLabels = Partial<Omit<SidebarLabels, 'archive' | 'create' | 'nav'>> & {
  /**
   * アーカイブ操作文言の上書きです。
   */
  archive?: Partial<SidebarArchiveLabels>
  /**
   * 新規登録フォーム文言の上書きです。
   */
  create?: PartialSidebarCreateLabels
  /**
   * 固定ナビゲーション項目ごとの上書き文言です。
   */
  nav?: Partial<SidebarLabels['nav']>
}

/**
 * 新規登録モーダルの既定文言を部分的に上書きする入力です。
 */
type PartialSidebarCreateLabels = Partial<Omit<SidebarCreateLabels, 'toneLabels'>> & {
  /**
   * プロジェクト色ごとの表示名の上書きです。
   */
  toneLabels?: Partial<SidebarCreateLabels['toneLabels']>
}

const projectToneClasses: Record<SidebarProjectTone, string> = {
  blue: 'border-teal-300/70 text-teal-200 bg-teal-500/10',
  purple: 'border-slate-300/70 text-slate-200 bg-white/10',
  green: 'border-emerald-400/70 text-emerald-300 bg-emerald-500/10',
  yellow: 'border-amber-300/70 text-amber-200 bg-amber-400/15',
}

const projectToneSwatchClasses: Record<SidebarProjectTone, string> = {
  blue: 'border-teal-300 bg-teal-600',
  purple: 'border-slate-300 bg-slate-500',
  green: 'border-emerald-300 bg-emerald-500',
  yellow: 'border-amber-200 bg-amber-400',
}

const projectToneOptions = ['blue', 'purple', 'green', 'yellow'] as const

function resolveDefaultCreateMode(
  teams: SidebarTeam[],
  onCreateTeam: SidebarProps['onCreateTeam'],
  onCreateProject: SidebarProps['onCreateProject'],
): SidebarCreateMode {
  if (onCreateProject && teams.length > 0) {
    return 'project'
  }

  if (onCreateTeam) {
    return 'team'
  }

  return 'project'
}

/**
 * チームとプロジェクト階層を含むアプリ共通サイドバーです。
 */
export function Sidebar({
  workspaceName = 'mukuroji',
  labels,
  activeNavId: controlledActiveNavId,
  defaultActiveNavId,
  activeTeamViewId: controlledActiveTeamViewId,
  defaultActiveTeamViewId,
  activeTeamId: controlledActiveTeamId,
  defaultActiveTeamId,
  activeProjectId: controlledActiveProjectId,
  activeProjectTeamId: controlledActiveProjectTeamId,
  defaultActiveProjectId,
  defaultActiveProjectTeamId,
  expandedTeamIds: controlledExpandedTeamIds,
  defaultExpandedTeamIds,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  defaultCreatePanelOpen = false,
  defaultQuickAccessManagerOpen = false,
  autoSelectInitialProject = true,
  inboxCount = 0,
  teams,
  quickAccessProjects = [],
  isQuickAccessSaving = false,
  isAllProjectsActive = false,
  className = '',
  onCollapsedChange,
  onOpenSearch,
  onCreateTeam,
  onCreateProject,
  onArchiveTeam,
  onArchiveProject,
  onSelectNav,
  onSelectTeamView,
  onSelectProject,
  onShowAllQuickAccess,
  onShowAllProjects,
  onMoveQuickAccessProject,
  onRemoveQuickAccessProject,
  onExpandedTeamIdsChange,
}: SidebarProps) {
  const resolvedLabels = resolveLabels(labels)
  const defaultProjectTeamId = defaultActiveProjectId
    ? defaultActiveProjectTeamId ?? findProjectTeamId(teams, defaultActiveProjectId)
    : undefined
  const shouldSelectInitialProject =
    autoSelectInitialProject &&
    controlledActiveNavId === undefined &&
    controlledActiveTeamId === undefined &&
    controlledActiveTeamViewId === undefined &&
    controlledActiveProjectId === undefined &&
    controlledActiveProjectTeamId === undefined &&
    defaultActiveNavId === undefined
  const initialTeamId =
    defaultActiveTeamId ?? defaultProjectTeamId ?? (shouldSelectInitialProject ? teams[0]?.id : undefined)
  const initialTeam = teams.find((team) => team.id === initialTeamId) ?? teams[0]
  const initialProjectId =
    defaultActiveProjectId ?? (shouldSelectInitialProject ? initialTeam?.projects?.[0]?.id : undefined)
  const initialExpandedTeamIds =
    defaultExpandedTeamIds ??
    teams.filter((team) => team.expanded ?? team.id === initialTeamId).map((team) => team.id)

  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed)
  const [createModalDefaultMode, setCreateModalDefaultMode] = useState<SidebarCreateMode>(() =>
    resolveDefaultCreateMode(teams, onCreateTeam, onCreateProject),
  )
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(defaultCreatePanelOpen)
  const [isQuickAccessManagerOpen, setIsQuickAccessManagerOpen] =
    useState(defaultQuickAccessManagerOpen)
  const [isTeamSwitcherOpen, setIsTeamSwitcherOpen] = useState(false)
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const [teamSearchQuery, setTeamSearchQuery] = useState('')
  const [internalActiveNavId, setInternalActiveNavId] = useState<SidebarNavId | undefined>(
    defaultActiveNavId,
  )
  const [internalActiveTeamViewId, setInternalActiveTeamViewId] = useState<
    SidebarTeamViewId | undefined
  >(defaultActiveTeamViewId)
  const [internalActiveTeamId, setInternalActiveTeamId] = useState<string | undefined>(
    initialTeamId,
  )
  const [internalActiveProjectId, setInternalActiveProjectId] = useState<string | undefined>(
    initialProjectId,
  )
  const [internalActiveProjectTeamId, setInternalActiveProjectTeamId] = useState<
    string | undefined
  >(defaultProjectTeamId)
  const [internalExpandedTeamIds, setInternalExpandedTeamIds] = useState(initialExpandedTeamIds)
  const [internalCollapsedTeamIds, setInternalCollapsedTeamIds] = useState<string[]>([])
  const [archivingItemKey, setArchivingItemKey] = useState<string | undefined>()
  const [archiveErrorMessage, setArchiveErrorMessage] = useState<string | undefined>()
  const [archiveTarget, setArchiveTarget] = useState<SidebarArchiveTarget | undefined>()
  const archiveReturnFocusElementRef = useRef<HTMLElement | null>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const quickAccessManageButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const teamSwitcherButtonRef = useRef<HTMLButtonElement>(null)

  const isCollapsed = controlledCollapsed ?? internalCollapsed
  const activeProjectId = controlledActiveProjectId ?? internalActiveProjectId
  const activeProjectTeamId = controlledActiveProjectTeamId !== undefined
    ? controlledActiveProjectTeamId
    : internalActiveProjectTeamId
  const isAggregateProjectScope = Boolean(activeProjectId) && activeProjectTeamId === null
  const projectTeamId = activeProjectId && !isAggregateProjectScope
    ? activeProjectTeamId ?? findProjectTeamId(teams, activeProjectId)
    : undefined
  const activeTeamViewId = controlledActiveTeamViewId ?? internalActiveTeamViewId
  const activeTeamId = controlledActiveTeamId ?? (
    isAggregateProjectScope ? undefined : projectTeamId ?? internalActiveTeamId
  )
  const activeNavId =
    activeProjectId || activeTeamId || activeTeamViewId
      ? undefined
      : controlledActiveNavId ?? internalActiveNavId
  const expandedTeamIdsFromData = teams.filter((team) => team.expanded).map((team) => team.id)
  const uncontrolledExpandedTeamIds = mergeUniqueIds(
    expandedTeamIdsFromData,
    internalExpandedTeamIds,
  ).filter((teamId) => !internalCollapsedTeamIds.includes(teamId))
  const expandedTeamIds = projectTeamId
    ? ensureIncludes(controlledExpandedTeamIds ?? uncontrolledExpandedTeamIds, projectTeamId)
    : controlledExpandedTeamIds ?? uncontrolledExpandedTeamIds

  const navItems = primaryNavItems.map((item) =>
    item.id === 'inbox' ? { ...item, badge: inboxCount } : item,
  )
  const secondaryItems = secondaryNavItems
  const currentTeam = teams.find((team) => team.id === activeTeamId) ?? teams[0]
  const normalizedTeamSearchQuery = teamSearchQuery.trim().toLocaleLowerCase()
  const filteredTeams = normalizedTeamSearchQuery
    ? teams.filter((team) =>
        team.name.toLocaleLowerCase().includes(normalizedTeamSearchQuery)
      )
    : teams
  const visibleQuickAccessProjects = quickAccessProjects.slice(0, 5)
  const canCreate = Boolean(onCreateTeam || onCreateProject)
  const createDialogId = useId()

  const requestArchiveTeam = (teamId: string) => {
    const team = teams.find((candidate) => candidate.id === teamId)

    if (!onArchiveTeam || !team || archivingItemKey) {
      return
    }

    archiveReturnFocusElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setArchiveErrorMessage(undefined)
    setArchiveTarget({ kind: 'team', name: team.name, teamId })
  }

  const confirmArchive = async () => {
    if (!archiveTarget || archivingItemKey) {
      return
    }

    const itemKey = archiveTarget.kind === 'team'
      ? createTeamArchiveKey(archiveTarget.teamId)
      : `project:${archiveTarget.teamId}:${archiveTarget.projectId ?? ''}`

    setArchiveErrorMessage(undefined)
    setArchivingItemKey(itemKey)

    try {
      if (archiveTarget.kind === 'team') {
        await onArchiveTeam?.(archiveTarget.teamId)
      } else if (archiveTarget.projectId) {
        await onArchiveProject?.(archiveTarget.teamId, archiveTarget.projectId)
      }
      setArchiveTarget(undefined)
    } catch {
      setArchiveErrorMessage(resolvedLabels.archive.error)
    } finally {
      setArchivingItemKey(undefined)
    }
  }

  const updateCollapsed = (nextCollapsed: boolean) => {
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(nextCollapsed)
    }
    onCollapsedChange?.(nextCollapsed)
  }

  const updateActiveNav = (navId: SidebarNavId) => {
    setInternalActiveNavId(navId)
    setInternalActiveTeamId(undefined)
    setInternalActiveTeamViewId(undefined)
    setInternalActiveProjectId(undefined)
    setInternalActiveProjectTeamId(undefined)
    onSelectNav?.(navId)
  }

  const updateActiveProject = (projectId: string, teamId: string) => {
    const team = teams.find((candidate) => candidate.id === teamId)

    if (team) {
      setInternalActiveTeamId(team.id)
      updateExpandedTeamIds(ensureIncludes(expandedTeamIds, team.id))
    }

    setInternalActiveNavId(undefined)
    setInternalActiveTeamViewId(undefined)
    setInternalActiveProjectId(projectId)
    setInternalActiveProjectTeamId(teamId)
    onSelectProject?.(projectId, teamId)
  }

  const updateActiveTeamView = (teamId: string, viewId: SidebarTeamViewId) => {
    setInternalActiveNavId(undefined)
    setInternalActiveTeamId(teamId)
    setInternalActiveTeamViewId(viewId)
    setInternalActiveProjectId(undefined)
    setInternalActiveProjectTeamId(undefined)
    updateExpandedTeamIds(ensureIncludes(expandedTeamIds, teamId))
    onSelectTeamView?.(teamId, viewId)
  }

  const updateExpandedTeamIds = (nextTeamIds: string[]) => {
    if (controlledExpandedTeamIds === undefined) {
      setInternalExpandedTeamIds(nextTeamIds)
      setInternalCollapsedTeamIds((currentTeamIds) =>
        currentTeamIds.filter((teamId) => !nextTeamIds.includes(teamId)),
      )
    }
    onExpandedTeamIdsChange?.(nextTeamIds)
  }

  const openCreateModal = () => {
    setCreateModalDefaultMode(resolveDefaultCreateMode(teams, onCreateTeam, onCreateProject))
    setIsCreateModalOpen(true)
  }

  return (
    <>
      <aside
        className={`relative flex h-dvh max-h-dvh min-h-0 flex-none flex-col overflow-hidden bg-[var(--workbench-sidebar)] py-4 text-white shadow-[1px_0_0_rgba(255,255,255,0.08)] transition-[width,padding] duration-200 min-[981px]:h-svh min-[981px]:max-h-svh ${isCollapsed ? 'w-[76px] px-3' : 'w-[292px] max-w-[calc(100vw-32px)] px-4'} ${className}`}
        aria-label={resolvedLabels.ariaLabel}
        data-collapsed={isCollapsed}
        inert={isCreateModalOpen || isQuickAccessManagerOpen || archiveTarget ? true : undefined}
        ref={sidebarRef}
        tabIndex={-1}
      >
        <div
          className={`mb-5 flex flex-none items-center ${isCollapsed ? 'flex-col gap-3 px-0' : 'justify-between px-1'}`}
        >
          <div className={`flex min-w-0 items-center gap-3 ${isCollapsed ? 'justify-center' : ''}`}>
            <BrandMark />
            <span
              className={`truncate text-app-brand font-semibold tracking-[0.01em] transition-opacity ${isCollapsed ? 'sr-only' : ''}`}
            >
              {workspaceName}
            </span>
          </div>
          <button
            className="grid h-9 w-9 flex-none place-items-center rounded-lg text-slate-200 transition hover:bg-white/10 hover:text-white"
            type="button"
            aria-label={isCollapsed ? resolvedLabels.expand : resolvedLabels.collapse}
            aria-expanded={!isCollapsed}
            onClick={() => updateCollapsed(!isCollapsed)}
          >
            {isCollapsed ? (
              <ChevronsRightIcon className="h-5 w-5" />
            ) : (
              <ChevronsLeftIcon className="h-5 w-5" />
            )}
          </button>
        </div>

        {onOpenSearch ? (
          <button
            aria-keyshortcuts="Control+K Meta+K"
            className={`mb-4 flex h-10 flex-none items-center rounded-lg border border-white/12 bg-white/[0.06] text-sm font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/10 focus-visible:bg-white/10 ${
              isCollapsed ? 'w-full justify-center px-0' : 'w-full justify-between gap-3 px-3'
            }`}
            data-testid="sidebar-search-trigger"
            onClick={onOpenSearch}
            title={resolvedLabels.search}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-3">
              <SearchIcon className="h-[18px] w-[18px] flex-none" />
              <span className={isCollapsed ? 'sr-only' : 'truncate'}>{resolvedLabels.search}</span>
            </span>
            {isCollapsed ? null : (
              <kbd className="rounded border border-white/15 bg-black/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] text-slate-300">
                {resolvedLabels.searchShortcut}
              </kbd>
            )}
          </button>
        ) : null}

        <nav className="flex-none space-y-1" aria-label={resolvedLabels.globalNavigation}>
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              active={activeNavId === item.id}
              collapsed={isCollapsed}
              id={item.id}
              icon={item.icon}
              label={resolvedLabels.nav[item.id]}
              badge={item.badge}
              unreadCount={resolvedLabels.unreadCount}
              onSelect={updateActiveNav}
            />
          ))}
        </nav>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <section aria-label={resolvedLabels.quickAccess}>
            {!isCollapsed ? (
              <div className="flex h-8 items-center justify-between px-1 text-app-meta font-semibold uppercase tracking-[0.08em] text-slate-300">
                <span className="truncate">{resolvedLabels.quickAccess}</span>
                <button
                  ref={quickAccessManageButtonRef}
                  aria-expanded={isQuickAccessManagerOpen}
                  aria-haspopup="dialog"
                  aria-label={resolvedLabels.manageQuickAccess}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-200 transition hover:bg-white/10 hover:text-white"
                  onClick={() => setIsQuickAccessManagerOpen(true)}
                  title={resolvedLabels.manageQuickAccess}
                  type="button"
                >
                  <MoreHorizontalIcon className="h-5 w-5" />
                </button>
              </div>
            ) : null}
            <div className="mt-1 space-y-1">
              {visibleQuickAccessProjects.map((project) => (
                <QuickAccessProjectButton
                  key={`${project.teamId}\u0000${project.projectId}`}
                  active={
                    activeProjectId === project.projectId &&
                    (activeProjectTeamId === undefined || activeProjectTeamId === project.teamId)
                  }
                  collapsed={isCollapsed}
                  project={project}
                  onSelect={updateActiveProject}
                />
              ))}
              {quickAccessProjects.length === 0 && !isCollapsed ? (
                <p className="px-2 py-1.5 text-app-caption leading-5 text-slate-400">
                  {resolvedLabels.quickAccessEmpty}
                </p>
              ) : null}
              {quickAccessProjects.length > 5 && !isCollapsed && onShowAllQuickAccess ? (
                <button
                  className="min-h-8 w-full rounded-lg px-2 text-left text-app-meta font-semibold text-teal-200 transition hover:bg-white/10 hover:text-teal-100"
                  onClick={onShowAllQuickAccess}
                  type="button"
                >
                  {resolvedLabels.showAllQuickAccess}
                </button>
              ) : null}
            </div>
          </section>

          <section aria-label={resolvedLabels.currentTeam} className="mt-5">
            {!isCollapsed ? (
              <p className="px-1 text-app-meta font-semibold uppercase tracking-[0.08em] text-slate-300">
                {resolvedLabels.currentTeam}
              </p>
            ) : null}
            {currentTeam ? (
              <div className="relative mt-1">
                <button
                  ref={teamSwitcherButtonRef}
                  aria-expanded={isTeamSwitcherOpen}
                  aria-haspopup="dialog"
                  aria-label={isCollapsed ? `${resolvedLabels.switchTeam}: ${currentTeam.name}` : undefined}
                  className={`flex h-10 w-full items-center gap-3 rounded-lg text-left font-semibold text-white transition hover:bg-white/10 ${isCollapsed ? 'justify-center px-0' : 'px-2'}`}
                  onClick={() => {
                    setIsMoreOpen(false)
                    if (isCollapsed && !isTeamSwitcherOpen) {
                      updateCollapsed(false)
                    }
                    setIsTeamSwitcherOpen((value) => !value)
                  }}
                  title={isCollapsed ? currentTeam.name : resolvedLabels.switchTeam}
                  type="button"
                >
                  <TeamAvatar name={currentTeam.name} />
                  <span className={isCollapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>
                    {currentTeam.name}
                  </span>
                  {isCollapsed ? null : <ChevronDownIcon className="h-4 w-4 flex-none" />}
                </button>
                {isTeamSwitcherOpen ? (
                  <div
                    aria-label={resolvedLabels.switchTeam}
                    className="mt-1 rounded-xl border border-white/10 bg-[#21302c] p-2 shadow-xl"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setIsTeamSwitcherOpen(false)
                        setTeamSearchQuery('')
                        window.requestAnimationFrame(() => {
                          teamSwitcherButtonRef.current?.focus()
                        })
                      } else if (event.key === 'Tab') {
                        trapFocus(event.nativeEvent, event.currentTarget)
                      }
                    }}
                    role="dialog"
                  >
                    <label className={isCollapsed ? 'sr-only' : 'block'}>
                      <span className="sr-only">{resolvedLabels.searchTeams}</span>
                      <span className="relative block">
                        <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                        <input
                          autoFocus
                          className="h-9 w-full rounded-lg border border-white/10 bg-black/15 pl-8 pr-2 text-sm text-white outline-none placeholder:text-slate-400 focus:border-teal-400"
                          onChange={(event) => setTeamSearchQuery(event.currentTarget.value)}
                          placeholder={resolvedLabels.searchTeams}
                          value={teamSearchQuery}
                        />
                      </span>
                    </label>
                    <div className={`mt-1 max-h-48 overflow-y-auto ${isCollapsed ? 'min-w-0' : ''}`}>
                      {filteredTeams.map((team) => (
                        <button
                          aria-current={team.id === currentTeam.id ? 'true' : undefined}
                          className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition hover:bg-white/10 ${team.id === currentTeam.id ? 'bg-teal-500/20 text-white' : 'text-slate-200'}`}
                          key={team.id}
                          onClick={() => {
                            updateActiveTeamView(team.id, 'overview')
                            setIsTeamSwitcherOpen(false)
                            setTeamSearchQuery('')
                            window.requestAnimationFrame(() => {
                              teamSwitcherButtonRef.current?.focus()
                            })
                          }}
                          title={team.name}
                          type="button"
                        >
                          <TeamAvatar name={team.name} />
                          <span className={isCollapsed ? 'sr-only' : 'truncate'}>{team.name}</span>
                        </button>
                      ))}
                      {filteredTeams.length === 0 && !isCollapsed ? (
                        <p className="px-2 py-3 text-app-caption text-slate-400">
                          {resolvedLabels.noTeamsFound}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <CurrentTeamNavigation
                  activeTeamId={activeTeamId}
                  activeTeamViewId={activeTeamViewId}
                  collapsed={isCollapsed}
                  labels={resolvedLabels}
                  team={currentTeam}
                  onSelectTeamView={updateActiveTeamView}
                />
              </div>
            ) : !isCollapsed ? (
              <p className="px-2 py-2 text-app-caption text-slate-400">
                {resolvedLabels.create.noTeams}
              </p>
            ) : null}
          </section>

          {archiveErrorMessage && !isCollapsed ? (
            <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/12 px-3 py-2 text-app-caption font-bold leading-5 text-red-100" role="alert">
              {archiveErrorMessage}
            </p>
          ) : null}
        </div>

        <div
          className="relative mt-3 flex-none border-t border-white/10 pt-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && isMoreOpen) {
              event.preventDefault()
              setIsMoreOpen(false)
              window.requestAnimationFrame(() => moreButtonRef.current?.focus())
            }
          }}
        >
          <button
            ref={moreButtonRef}
            aria-expanded={isMoreOpen}
            aria-haspopup="true"
            className={`flex h-9 w-full items-center gap-3 rounded-lg text-left text-app-body font-medium text-slate-100 transition hover:bg-white/10 hover:text-white ${isCollapsed ? 'justify-center px-0' : 'px-2'} ${secondaryItems.some((item) => item.id === activeNavId) || isAllProjectsActive ? 'bg-teal-500/20 text-white' : ''}`}
            onClick={() => {
              setIsTeamSwitcherOpen(false)
              if (isCollapsed && !isMoreOpen) {
                updateCollapsed(false)
              }
              setIsMoreOpen((value) => !value)
            }}
            title={resolvedLabels.more}
            type="button"
          >
            <MoreHorizontalIcon className="h-5 w-5 flex-none" />
            <span className={isCollapsed ? 'sr-only' : 'truncate'}>{resolvedLabels.more}</span>
            {isCollapsed ? null : <ChevronDownIcon className="ml-auto h-4 w-4" />}
          </button>
          {isMoreOpen ? (
            <div
              className="mt-1 space-y-1 rounded-xl border border-white/10 bg-[#21302c] p-1.5 shadow-xl"
            >
              {onShowAllProjects ? (
                <button
                  aria-current={isAllProjectsActive ? 'page' : undefined}
                  className={`flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-app-body font-medium text-slate-100 transition hover:bg-white/10 ${isAllProjectsActive ? 'bg-teal-500/20 text-white' : ''}`}
                  onClick={() => {
                    setIsMoreOpen(false)
                    onShowAllProjects()
                  }}
                  type="button"
                >
                  <ProjectGridIcon className="h-5 w-5 flex-none" />
                  <span className="truncate">{resolvedLabels.allProjects}</span>
                </button>
              ) : null}
              {secondaryItems.map((item) => (
                <NavButton
                  key={item.id}
                  active={activeNavId === item.id}
                  collapsed={isCollapsed}
                  id={item.id}
                  icon={item.icon}
                  label={resolvedLabels.nav[item.id]}
                  unreadCount={resolvedLabels.unreadCount}
                  onSelect={(navId) => {
                    setIsMoreOpen(false)
                    updateActiveNav(navId)
                  }}
                />
              ))}
              {canCreate ? (
                <button
                  ref={createButtonRef}
                  aria-controls={isCreateModalOpen ? createDialogId : undefined}
                  aria-haspopup="dialog"
                  className={`flex h-9 w-full items-center gap-3 rounded-lg text-left text-app-body font-medium text-slate-100 transition hover:bg-white/10 ${isCollapsed ? 'justify-center px-0' : 'px-2'}`}
                  onClick={() => {
                    setIsMoreOpen(false)
                    openCreateModal()
                  }}
                  title={resolvedLabels.create.title}
                  type="button"
                >
                  <PlusIcon className="h-5 w-5 flex-none" />
                  <span className={isCollapsed ? 'sr-only' : 'truncate'}>{resolvedLabels.create.title}</span>
                </button>
              ) : null}
              {currentTeam && onArchiveTeam ? (
                <button
                  className={`flex h-9 w-full items-center gap-3 rounded-lg text-left text-app-body font-medium text-slate-300 transition hover:bg-red-500/15 hover:text-red-100 ${isCollapsed ? 'justify-center px-0' : 'px-2'}`}
                  onClick={() => {
                    setIsMoreOpen(false)
                    requestArchiveTeam(currentTeam.id)
                  }}
                  title={resolvedLabels.archive.team(currentTeam.name)}
                  type="button"
                >
                  <ArchiveIcon className="h-5 w-5 flex-none" />
                  <span className={isCollapsed ? 'sr-only' : 'truncate'}>
                    {resolvedLabels.archive.team(currentTeam.name)}
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <nav className="mt-2 flex-none space-y-1" aria-label={resolvedLabels.utilityNavigation}>
          {utilityNavItems.map((item) => (
            <NavButton
              key={item.id}
              active={activeNavId === item.id}
              collapsed={isCollapsed}
              id={item.id}
              icon={item.icon}
              label={resolvedLabels.nav[item.id]}
              unreadCount={resolvedLabels.unreadCount}
              onSelect={updateActiveNav}
            />
          ))}
        </nav>
      </aside>
      {isQuickAccessManagerOpen ? (
        <SidebarQuickAccessManagerModal
          isBusy={isQuickAccessSaving}
          labels={resolvedLabels}
          projects={quickAccessProjects}
          returnFocusRef={quickAccessManageButtonRef}
          onMove={onMoveQuickAccessProject}
          onRemove={onRemoveQuickAccessProject
            ? async (projectId, teamId, projectName) => {
                setIsQuickAccessManagerOpen(false)
                await onRemoveQuickAccessProject(projectId, teamId, projectName)
              }
            : undefined}
          onRequestClose={() => setIsQuickAccessManagerOpen(false)}
        />
      ) : null}
      {canCreate && isCreateModalOpen ? (
        <SidebarRegistrationModal
          defaultMode={createModalDefaultMode}
          defaultProjectTeamId={activeTeamId}
          dialogId={createDialogId}
          labels={resolvedLabels.create}
          teams={teams}
          onCreateProject={onCreateProject}
          onCreateTeam={onCreateTeam}
          returnFocusRef={createButtonRef}
          onRequestClose={() => setIsCreateModalOpen(false)}
        />
      ) : null}
      {archiveTarget ? (
        <SidebarArchiveConfirmationModal
          errorMessage={archiveErrorMessage}
          isBusy={Boolean(archivingItemKey)}
          labels={resolvedLabels.archive}
          fallbackFocusRef={sidebarRef}
          returnFocusRef={archiveReturnFocusElementRef}
          target={archiveTarget}
          onConfirm={confirmArchive}
          onRequestClose={() => {
            if (!archivingItemKey) {
              setArchiveErrorMessage(undefined)
              setArchiveTarget(undefined)
            }
          }}
        />
      ) : null}
    </>
  )
}

/** Props accepted by the Quick Access ordering and removal dialog. */
type SidebarQuickAccessManagerModalProps = {
  /** Whether a preference replacement is currently in progress. */
  isBusy: boolean
  /** Resolved sidebar labels. */
  labels: SidebarLabels
  /** Complete ordered shortcut collection. */
  projects: SidebarQuickAccessProject[]
  /** Trigger that regains focus after the dialog closes. */
  returnFocusRef: RefObject<HTMLButtonElement | null>
  /** Moves one Project by one stable-order position. */
  onMove?: (
    project: SidebarQuickAccessProject,
    direction: 'up' | 'down',
  ) => void | Promise<void>
  /** Removes one Project shortcut. */
  onRemove?: (
    projectId: string,
    teamId: string,
    projectName: string,
  ) => void | Promise<void>
  /** Requests that the modal close. */
  onRequestClose: () => void
}

/** Renders accessible Quick Access ordering and removal controls. */
function SidebarQuickAccessManagerModal({
  isBusy,
  labels,
  projects,
  returnFocusRef,
  onMove,
  onRemove,
  onRequestClose,
}: SidebarQuickAccessManagerModalProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current
    findInitialFocusableElement(dialogRef.current)?.focus()
    return () => returnFocusElement?.focus()
  }, [returnFocusRef])

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) onRequestClose()
      }}
    >
      <section
        aria-busy={isBusy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 text-[var(--workbench-text)] shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !isBusy) {
            event.preventDefault()
            onRequestClose()
          } else if (event.key === 'Tab') {
            trapFocus(event.nativeEvent, dialogRef.current ?? event.currentTarget)
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold" id={titleId}>{labels.quickAccessDialogTitle}</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">
              {labels.quickAccessDialogDescription}
            </p>
          </div>
          <button
            aria-label={labels.closeQuickAccessDialog}
            className="grid h-9 w-9 flex-none place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            data-autofocus
            disabled={isBusy}
            onClick={onRequestClose}
            type="button"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </header>

        {projects.length === 0 ? (
          <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            {labels.quickAccessEmpty}
          </p>
        ) : (
          <ol className="mt-5 max-h-[min(52vh,420px)] space-y-2 overflow-y-auto pr-1">
            {projects.map((project, index) => {
              const tone = project.tone ?? 'blue'
              const isMoveUpDisabled = isBusy || index === 0 || !onMove
              const isMoveDownDisabled = isBusy || index === projects.length - 1 || !onMove
              return (
                <li
                  className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm"
                  key={`${project.teamId}\u0000${project.projectId}`}
                >
                  <ProjectGlyph tone={tone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{project.name}</span>
                    <span className="block truncate text-xs text-slate-500">{project.teamName}</span>
                  </span>
                  <span className="flex flex-none items-center gap-1">
                    <button
                      aria-label={`${labels.moveQuickAccessUp}: ${project.name}`}
                      aria-disabled={isMoveUpDisabled}
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 aria-disabled:cursor-not-allowed aria-disabled:opacity-30"
                      onClick={() => {
                        if (!isMoveUpDisabled) void onMove?.(project, 'up')
                      }}
                      type="button"
                    >
                      <ChevronDownIcon className="h-4 w-4 rotate-180" />
                    </button>
                    <button
                      aria-label={`${labels.moveQuickAccessDown}: ${project.name}`}
                      aria-disabled={isMoveDownDisabled}
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 aria-disabled:cursor-not-allowed aria-disabled:opacity-30"
                      onClick={() => {
                        if (!isMoveDownDisabled) void onMove?.(project, 'down')
                      }}
                      type="button"
                    >
                      <ChevronDownIcon className="h-4 w-4" />
                    </button>
                    <button
                      aria-label={`${labels.removeQuickAccess}: ${project.name}`}
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                      disabled={isBusy || !onRemove}
                      onClick={() => void onRemove?.(
                        project.projectId,
                        project.teamId,
                        project.name,
                      )}
                      type="button"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}

/**
 * サイドバーのアーカイブ確認 dialog に渡す props です。
 */
type SidebarArchiveConfirmationModalProps = {
  /**
   * API 失敗時に dialog 内へ表示するメッセージです。
   */
  errorMessage?: string
  /**
   * 実行後に呼び出し元が消えた場合のフォーカス復帰先です。
   */
  fallbackFocusRef: RefObject<HTMLElement | null>
  /**
   * アーカイブ API を実行中かどうかです。
   */
  isBusy: boolean
  /**
   * dialog 内で使う表示文言です。
   */
  labels: SidebarArchiveLabels
  /**
   * dialog を閉じたあとにフォーカスを戻す操作要素の ref です。
   */
  returnFocusRef: RefObject<HTMLElement | null>
  /**
   * 確認対象のチームまたはプロジェクトです。
   */
  target: SidebarArchiveTarget
  /**
   * アーカイブを確定するときの callback です。
   */
  onConfirm: () => void | Promise<void>
  /**
   * dialog を閉じる callback です。
   */
  onRequestClose: () => void
}

function SidebarArchiveConfirmationModal({
  errorMessage,
  fallbackFocusRef,
  isBusy,
  labels,
  returnFocusRef,
  target,
  onConfirm,
  onRequestClose,
}: SidebarArchiveConfirmationModalProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const dialogId = useId()
  const dialogTitleId = `${dialogId}-title`
  const dialogDescriptionId = `${dialogId}-description`

  useEffect(() => {
    const fallbackFocusElement = fallbackFocusRef.current
    const returnFocusElement = returnFocusRef.current

    findInitialFocusableElement(dialogRef.current)?.focus()

    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusElement?.isConnected) {
          returnFocusElement.focus()
          return
        }

        fallbackFocusElement?.focus()
      })
    }
  }, [fallbackFocusRef, returnFocusRef])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current

      if (event.key === 'Tab' && dialog) {
        trapFocus(event, dialog)
        return
      }

      if (event.key === 'Escape' && !isBusy) {
        onRequestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, onRequestClose])

  useEffect(() => {
    const dialog = dialogRef.current

    if (!dialog) {
      return
    }

    if (isBusy) {
      dialog.focus()
      return
    }

    if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
      findInitialFocusableElement(dialog)?.focus()
    }
  }, [isBusy])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!isBusy) {
          onRequestClose()
        }
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={dialogDescriptionId}
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="workbench-panel w-full max-w-[440px] overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2 className="text-xl font-semibold text-[var(--workbench-text)]" id={dialogTitleId}>
            {labels.confirmTitle}
          </h2>
        </div>
        <div className="p-6">
          <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]" id={dialogDescriptionId}>
            {target.kind === 'team'
              ? labels.confirmTeamDescription(target.name)
              : labels.confirmProjectDescription(target.name)}
          </p>
          {errorMessage ? (
            <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-autofocus
              disabled={isBusy}
              onClick={onRequestClose}
              type="button"
            >
              {labels.cancel}
            </button>
            <button
              className="min-h-10 rounded-[7px] border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white transition-colors duration-150 hover:border-red-800 hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isBusy}
              onClick={() => void onConfirm()}
              type="button"
            >
              {isBusy ? labels.archiving : labels.confirm}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SidebarRegistrationModal({
  defaultMode,
  defaultProjectTeamId,
  dialogId,
  labels,
  returnFocusRef,
  teams,
  onCreateProject,
  onCreateTeam,
  onRequestClose,
}: {
  defaultMode: SidebarCreateMode
  defaultProjectTeamId?: string
  dialogId: string
  labels: SidebarCreateLabels
  returnFocusRef: RefObject<HTMLButtonElement | null>
  teams: SidebarTeam[]
  onCreateProject?: (
    teamId: string,
    input: { name: string; tone: SidebarProjectTone },
  ) => void | Promise<void>
  onCreateTeam?: (input: { name: string }) => void | Promise<void>
  onRequestClose: () => void
}) {
  const [activeCreateMode, setActiveCreateMode] = useState<SidebarCreateMode>(() =>
    resolveVisibleCreateMode(defaultMode, onCreateTeam, onCreateProject),
  )
  const [selectedTone, setSelectedTone] = useState<SidebarProjectTone>('blue')
  const [isSavingTeam, setIsSavingTeam] = useState(false)
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [teamErrorMessage, setTeamErrorMessage] = useState<string | undefined>()
  const [projectErrorMessage, setProjectErrorMessage] = useState<string | undefined>()
  const dialogRef = useRef<HTMLElement>(null)
  const isSavingTeamRef = useRef(false)
  const isSavingProjectRef = useRef(false)
  const isBusy = isSavingTeam || isSavingProject
  const visibleCreateMode = resolveVisibleCreateMode(
    activeCreateMode,
    onCreateTeam,
    onCreateProject,
  )
  const titleId = `${dialogId}-title`
  const teamTabId = `${dialogId}-team-tab`
  const projectTabId = `${dialogId}-project-tab`
  const teamPanelId = `${dialogId}-team-panel`
  const projectPanelId = `${dialogId}-project-panel`
  const projectDefaultTeamId = teams.some((team) => team.id === defaultProjectTeamId)
    ? defaultProjectTeamId
    : teams[0]?.id
  const hasModeTabs = Boolean(onCreateTeam && onCreateProject)

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current

    findInitialFocusableElement(dialogRef.current)?.focus()

    return () => {
      returnFocusElement?.focus()
    }
  }, [returnFocusRef])

  useEffect(() => {
    findInitialFocusableElement(dialogRef.current)?.focus()
  }, [visibleCreateMode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current

      if (event.key === 'Tab' && dialog) {
        trapFocus(event, dialog)
        return
      }

      if (event.key === 'Escape' && !isBusy) {
        onRequestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isBusy, onRequestClose])

  const requestClose = () => {
    if (!isBusy) {
      onRequestClose()
    }
  }

  const updateCreateMode = (nextCreateMode: SidebarCreateMode) => {
    if (isBusy) {
      return
    }

    setActiveCreateMode(nextCreateMode)
    setTeamErrorMessage(undefined)
    setProjectErrorMessage(undefined)
  }

  const handleCreateTeam = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onCreateTeam || isSavingTeamRef.current) {
      return
    }

    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('teamName') ?? '').trim()

    setTeamErrorMessage(undefined)
    if (!name) {
      setTeamErrorMessage(labels.teamNameRequired)
      return
    }

    isSavingTeamRef.current = true
    setIsSavingTeam(true)
    void Promise.resolve()
      .then(() => onCreateTeam({ name }))
      .then(() => {
        form.reset()
        onRequestClose()
      })
      .catch((error: unknown) => {
        setTeamErrorMessage(resolveRegistrationErrorMessage(error, labels))
      })
      .finally(() => {
        isSavingTeamRef.current = false
        setIsSavingTeam(false)
      })
  }

  const handleCreateProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onCreateProject || isSavingProjectRef.current) {
      return
    }

    const form = event.currentTarget
    const formData = new FormData(form)
    const teamId = String(formData.get('teamId') ?? '')
    const name = String(formData.get('projectName') ?? '').trim()
    const toneValue = String(formData.get('tone') ?? selectedTone)
    const tone = isProjectTone(toneValue) ? toneValue : 'blue'

    setProjectErrorMessage(undefined)
    if (!teamId) {
      setProjectErrorMessage(labels.noTeams)
      return
    }
    if (!name) {
      setProjectErrorMessage(labels.projectNameRequired)
      return
    }

    isSavingProjectRef.current = true
    setIsSavingProject(true)
    void Promise.resolve()
      .then(() => onCreateProject(teamId, { name, tone }))
      .then(() => {
        form.reset()
        setSelectedTone('blue')
        onRequestClose()
      })
      .catch((error: unknown) => {
        setProjectErrorMessage(resolveRegistrationErrorMessage(error, labels))
      })
      .finally(() => {
        isSavingProjectRef.current = false
        setIsSavingProject(false)
      })
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 text-[var(--workbench-text)] backdrop-blur-sm"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="w-full max-w-[480px] overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface)] shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        id={dialogId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-[20px] font-semibold leading-tight text-[var(--workbench-text)]">
              {labels.title}
            </h2>
            <button
              className="grid h-9 w-9 flex-none place-items-center rounded-lg text-[var(--workbench-muted)] transition hover:bg-white hover:text-[var(--workbench-text)] disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              aria-label={labels.close}
              title={labels.close}
              disabled={isBusy}
              onClick={requestClose}
            >
              <XIcon className="h-5 w-5" />
            </button>
          </div>

          {hasModeTabs ? (
            <div
              className="mt-4 grid grid-cols-2 rounded-lg bg-[var(--workbench-border)] p-1"
              role="group"
              aria-label={labels.title}
            >
              <CreateModeTab
                active={visibleCreateMode === 'team'}
                disabled={isBusy}
                icon={UsersIcon}
                id={teamTabId}
                label={labels.teamMode}
                onSelect={() => updateCreateMode('team')}
              />
              <CreateModeTab
                active={visibleCreateMode === 'project'}
                disabled={isBusy}
                icon={PanelIcon}
                id={projectTabId}
                label={labels.projectMode}
                onSelect={() => updateCreateMode('project')}
              />
            </div>
          ) : null}
        </div>

        <div className="px-5 py-5">
          {visibleCreateMode === 'team' && onCreateTeam ? (
            <form
              className="grid gap-4"
              id={teamPanelId}
              aria-labelledby={titleId}
              onSubmit={handleCreateTeam}
            >
              <label className="grid gap-2 text-[13px] font-semibold text-[var(--workbench-text)]">
                {labels.teamName}
                <input
                  className="workbench-input h-11 px-3 text-[14px] placeholder:text-[var(--workbench-muted-soft)]"
                  name="teamName"
                  placeholder={labels.teamPlaceholder}
                  data-autofocus
                  autoFocus
                />
              </label>
              {teamErrorMessage ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-bold leading-5 text-red-700" role="alert">
                  {teamErrorMessage}
                </p>
              ) : null}
              <button
                className="workbench-button-primary h-11 px-4 text-[14px] disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
                disabled={isSavingTeam}
                type="submit"
              >
                {isSavingTeam ? labels.saving : labels.createTeam}
              </button>
            </form>
          ) : null}

          {visibleCreateMode === 'project' && onCreateProject ? (
            <form
              className="grid gap-4"
              id={projectPanelId}
              aria-labelledby={titleId}
              onSubmit={handleCreateProject}
            >
              <label className="grid gap-2 text-[13px] font-semibold text-[var(--workbench-text)]">
                {labels.team}
                <select
                  className="workbench-input h-11 px-3 text-[14px] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                  name="teamId"
                  defaultValue={projectDefaultTeamId}
                  disabled={teams.length === 0}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-[13px] font-semibold text-[var(--workbench-text)]">
                {labels.projectName}
                <input
                  className="workbench-input h-11 px-3 text-[14px] placeholder:text-[var(--workbench-muted-soft)] disabled:cursor-not-allowed disabled:bg-slate-100"
                  name="projectName"
                  placeholder={labels.projectPlaceholder}
                  disabled={teams.length === 0}
                  data-autofocus
                  autoFocus
                />
              </label>
              <fieldset className="grid gap-2">
                <legend className="text-[13px] font-semibold text-[var(--workbench-text)]">{labels.tone}</legend>
                <div className="grid grid-cols-4 gap-2">
                  {projectToneOptions.map((tone) => (
                    <label
                      className={`grid h-10 cursor-pointer place-items-center rounded-lg border transition focus-within:border-[var(--workbench-primary)] focus-within:ring-3 focus-within:ring-[#99d7cf]/35 ${
                        selectedTone === tone
                          ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] ring-3 ring-[#99d7cf]/35'
                          : 'border-[var(--workbench-border-strong)] bg-white hover:bg-[var(--workbench-surface-muted)]'
                      }`}
                      key={tone}
                      title={labels.toneLabels[tone]}
                    >
                      <input
                        checked={selectedTone === tone}
                        className="sr-only"
                        name="tone"
                        type="radio"
                        value={tone}
                        onChange={() => setSelectedTone(tone)}
                      />
                      <span
                        className={`h-4 w-4 rounded-[5px] border ${projectToneSwatchClasses[tone]}`}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{labels.toneLabels[tone]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {teams.length === 0 ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-bold leading-5 text-amber-800">
                  {labels.noTeams}
                </p>
              ) : null}
              {projectErrorMessage ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-bold leading-5 text-red-700" role="alert">
                  {projectErrorMessage}
                </p>
              ) : null}
              <button
                className="workbench-button-primary h-11 px-4 text-[14px] disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
                disabled={isSavingProject || teams.length === 0}
                type="submit"
              >
                {isSavingProject ? labels.saving : labels.createProject}
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function CreateModeTab({
  active,
  disabled,
  icon: Icon,
  id,
  label,
  onSelect,
}: {
  active: boolean
  disabled: boolean
  icon: ComponentType<SidebarIconProps>
  id: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      className={`flex h-10 items-center justify-center gap-2 rounded-md px-3 text-[13px] font-semibold transition disabled:cursor-not-allowed ${
        active
          ? 'bg-white text-[var(--workbench-text)] shadow-[0_3px_10px_rgba(23,32,29,0.1)]'
          : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
      }`}
      type="button"
      aria-pressed={active}
      disabled={disabled}
      id={id}
      onClick={onSelect}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  )
}

function resolveVisibleCreateMode(
  createMode: SidebarCreateMode,
  onCreateTeam: SidebarProps['onCreateTeam'],
  onCreateProject: SidebarProps['onCreateProject'],
) {
  if (createMode === 'project' && onCreateProject) {
    return 'project'
  }

  if (createMode === 'team' && onCreateTeam) {
    return 'team'
  }

  return onCreateTeam ? 'team' : 'project'
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function findInitialFocusableElement(container: HTMLElement | null) {
  return (
    container?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
    findFirstFocusableElement(container)
  )
}

function findFirstFocusableElement(container: HTMLElement | null) {
  return getFocusableElements(container)[0]
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return []
  }

  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute('aria-hidden') && element.tabIndex >= 0,
  )
}

function trapFocus(event: KeyboardEvent, container: HTMLElement) {
  const focusableElements = getFocusableElements(container)
  const firstFocusableElement = focusableElements[0]
  const lastFocusableElement = focusableElements[focusableElements.length - 1]

  if (!firstFocusableElement || !lastFocusableElement) {
    event.preventDefault()
    return
  }

  if (!container.contains(document.activeElement)) {
    event.preventDefault()
    firstFocusableElement.focus()
    return
  }

  if (event.shiftKey && document.activeElement === firstFocusableElement) {
    event.preventDefault()
    lastFocusableElement.focus()
    return
  }

  if (!event.shiftKey && document.activeElement === lastFocusableElement) {
    event.preventDefault()
    firstFocusableElement.focus()
  }
}

function NavButton({
  active,
  collapsed,
  id,
  icon: Icon,
  label,
  badge,
  unreadCount,
  onSelect,
}: {
  active: boolean
  collapsed: boolean
  id: SidebarNavId
  icon: ComponentType<SidebarIconProps>
  label: string
  badge?: number
  unreadCount: (count: number) => string
  onSelect: (navId: SidebarNavId) => void
}) {
  const badgeLabel = badge ? unreadCount(badge) : undefined
  const accessibleLabel = badgeLabel ? `${label} ${badgeLabel}` : label

  return (
    <button
      className={`group relative flex h-9 w-full items-center gap-3 rounded-lg text-left text-app-body font-medium transition hover:bg-white/10 hover:text-white ${collapsed ? 'justify-center px-0' : 'px-2'} ${
        active ? 'bg-teal-500/20 text-white' : 'text-slate-100'
      }`}
      type="button"
      aria-label={collapsed ? accessibleLabel : undefined}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? accessibleLabel : undefined}
      onClick={() => onSelect(id)}
    >
      {active ? (
        <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-teal-400" aria-hidden="true" />
      ) : null}
      <Icon className="h-5 w-5 flex-none text-slate-100 transition group-hover:text-white" />
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{label}</span>
      {badge ? (
        <span
          className={`grid h-6 min-w-6 place-items-center rounded-full bg-teal-500 px-2 text-app-caption font-bold leading-none text-white shadow-[0_8px_20px_rgba(20,184,166,0.28)] ${collapsed ? 'absolute right-0 top-0 h-5 min-w-5 px-1 text-app-micro' : ''}`}
          aria-label={badgeLabel}
        >
          {badge}
        </span>
      ) : null}
    </button>
  )
}

/** Renders the four stable views owned by the single current Team. */
function CurrentTeamNavigation({
  activeTeamId,
  activeTeamViewId,
  collapsed,
  labels,
  team,
  onSelectTeamView,
}: {
  /** Team ID highlighted by the current route. */
  activeTeamId?: string
  /** Team view highlighted by the current route. */
  activeTeamViewId?: SidebarTeamViewId
  /** Whether only icons are visible. */
  collapsed: boolean
  /** Resolved sidebar labels. */
  labels: SidebarLabels
  /** Current Team whose views are displayed. */
  team: SidebarTeam
  /** Navigates to one current-Team view. */
  onSelectTeamView: (teamId: string, viewId: SidebarTeamViewId) => void
}) {
  const isTeamActive = activeTeamId === team.id

  return (
    <div className={`mt-1 space-y-0.5 ${collapsed ? '' : 'pl-3'}`} data-testid={`sidebar-team-${team.id}`}>
      <SubNavButton
        active={isTeamActive && activeTeamViewId === 'overview'}
        collapsed={collapsed}
        icon={PanelIcon}
        label={labels.teamOverview}
        onClick={() => onSelectTeamView(team.id, 'overview')}
      />
      <SubNavButton
        active={isTeamActive && activeTeamViewId === 'issues'}
        collapsed={collapsed}
        icon={CheckCircleIcon}
        label={labels.issues}
        onClick={() => onSelectTeamView(team.id, 'issues')}
      />
      <SubNavButton
        active={isTeamActive && activeTeamViewId === 'projects'}
        collapsed={collapsed}
        icon={ProjectGridIcon}
        label={labels.projectCount(team.projects?.length ?? 0)}
        onClick={() => onSelectTeamView(team.id, 'projects')}
      />
      <SubNavButton
        active={isTeamActive && activeTeamViewId === 'members'}
        collapsed={collapsed}
        icon={UsersIcon}
        label={labels.members}
        onClick={() => onSelectTeamView(team.id, 'members')}
      />
    </div>
  )
}

/** Renders one ordered quick-access shortcut in expanded and collapsed modes. */
function QuickAccessProjectButton({
  active,
  collapsed,
  project,
  onSelect,
}: {
  /** Whether the shortcut represents the current route. */
  active: boolean
  /** Whether only the Project glyph is visible. */
  collapsed: boolean
  /** Resolved Team-owned Project shortcut. */
  project: SidebarQuickAccessProject
  /** Opens the Project within its saved Team context. */
  onSelect: (projectId: string, teamId: string) => void
}) {
  const tone = project.tone ?? 'blue'
  const accessibleLabel = `${project.name} · ${project.teamName}`

  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? accessibleLabel : undefined}
      className={`relative flex h-9 w-full items-center gap-3 rounded-lg text-left text-app-body font-medium transition hover:bg-white/10 hover:text-white ${collapsed ? 'justify-center px-0' : 'px-2'} ${active ? 'bg-teal-500/20 text-white' : 'text-slate-100'}`}
      onClick={() => onSelect(project.projectId, project.teamId)}
      title={collapsed ? accessibleLabel : project.teamName}
      type="button"
    >
      {active ? (
        <span aria-hidden="true" className="absolute inset-y-1 left-0 w-1 rounded-full bg-teal-400" />
      ) : null}
      <ProjectGlyph tone={tone} />
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{project.name}</span>
    </button>
  )
}

/** Renders a compact Team avatar with a meaningful text initial. */
function TeamAvatar({ name }: { /** Team name used to derive the initial. */ name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || 'T'
  return (
    <span aria-hidden="true" className="grid h-6 w-6 flex-none place-items-center rounded-md bg-teal-400/15 text-[11px] font-bold text-teal-100 ring-1 ring-inset ring-teal-300/30">
      {initial}
    </span>
  )
}

/** Renders the shared Project glyph used by sidebar shortcuts. */
function ProjectGlyph({ tone }: { /** Visual tone assigned to the Project. */ tone: SidebarProjectTone }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border ${projectToneClasses[tone]}`}
    >
      <span className="h-[7px] w-[8px] rounded-[2px] border border-current" />
    </span>
  )
}

/** Props accepted by one compact Team sub-navigation control. */
type SubNavButtonProps = {
  /** Whether this sub-navigation destination is current. */
  active: boolean
  /** Whether only the icon should remain visually exposed. */
  collapsed: boolean
  /** Icon rendered before the destination label. */
  icon: ComponentType<SidebarIconProps>
  /** Visible and accessible destination label. */
  label: string
  /** Selects the destination. */
  onClick: () => void
}

/** Renders one compact destination inside the current Team navigation. */
function SubNavButton({
  active,
  collapsed,
  icon: Icon,
  label,
  onClick,
}: SubNavButtonProps) {
  return (
    <button
      aria-label={collapsed ? label : undefined}
      className={`relative flex h-8 w-full items-center gap-3 rounded-lg text-left text-app-meta font-medium transition hover:bg-white/10 hover:text-white ${collapsed ? 'justify-center px-0' : 'px-2'} ${
        active ? 'bg-teal-500/20 text-white' : 'text-slate-100'
      }`}
      type="button"
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      onClick={onClick}
    >
      {active ? (
        <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-teal-400" aria-hidden="true" />
      ) : null}
      <Icon className="h-[18px] w-[18px] flex-none text-slate-100" />
      <span className={collapsed ? 'sr-only' : 'min-w-0 truncate'}>{label}</span>
    </button>
  )
}

function createTeamArchiveKey(teamId: string) {
  return `team:${teamId}`
}

function ensureIncludes(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value]
}

function mergeUniqueIds(currentValues: string[], additionalValues: string[]) {
  const nextValues = Array.from(new Set([...currentValues, ...additionalValues]))

  if (
    nextValues.length === currentValues.length &&
    nextValues.every((value, index) => value === currentValues[index])
  ) {
    return currentValues
  }

  return nextValues
}

function findProjectTeamId(teams: SidebarTeam[], projectId: string) {
  return teams.find((team) => team.projects?.some((project) => project.id === projectId))?.id
}

function isProjectTone(value: string): value is SidebarProjectTone {
  return (projectToneOptions as readonly string[]).includes(value)
}

function resolveRegistrationErrorMessage(error: unknown, labels: SidebarCreateLabels) {
  const message = error instanceof Error ? error.message : undefined

  if (message === 'projects.error.loading' || message === 'tasks.error.loading') {
    return labels.loadingError
  }

  return labels.error
}

function resolveLabels(labels: PartialSidebarLabels | undefined): SidebarLabels {
  const createLabels = labels?.create
  const archiveLabels = labels?.archive

  return {
    ...defaultLabels,
    ...labels,
    archive: {
      ...defaultLabels.archive,
      ...archiveLabels,
    },
    create: {
      ...defaultLabels.create,
      ...createLabels,
      toneLabels: {
        ...defaultLabels.create.toneLabels,
        ...createLabels?.toneLabels,
      },
    },
    nav: {
      ...defaultLabels.nav,
      ...labels?.nav,
    },
  }
}

function SvgBase({
  className,
  children,
}: SidebarIconProps & {
  children: ReactNode
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function HomeIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </SvgBase>
  )
}

/** Renders the Focus queue crosshair icon. */
function FocusIcon({ className }: SidebarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    </svg>
  )
}

function SearchIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </SvgBase>
  )
}

function CheckCircleIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.4 2.4 4.8-5.2" />
      <path d="M18 6.5h.01" />
    </SvgBase>
  )
}

function BellIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </SvgBase>
  )
}

function DocumentIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </SvgBase>
  )
}

function DashboardIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M4 20V10" />
      <path d="M10 20V5" />
      <path d="M16 20v-8" />
      <path d="M22 20H2" />
      <path d="M20 20V8" />
    </SvgBase>
  )
}

function PlanningIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M4 6h6" />
      <path d="M14 6h6" />
      <path d="M8 6v12" />
      <path d="M8 10h8" />
      <path d="M16 10v8" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="10" r="2" />
      <circle cx="8" cy="18" r="2" />
      <circle cx="16" cy="18" r="2" />
    </SvgBase>
  )
}

function ReportIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M4 20V12" />
      <path d="M10 20V7" />
      <path d="M16 20V4" />
      <path d="M22 20H2" />
    </SvgBase>
  )
}

function UsersIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </SvgBase>
  )
}

function PanelIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
      <path d="M8 17h8" />
    </SvgBase>
  )
}

/** Renders the grid-shaped icon used for Project directory destinations. */
function ProjectGridIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" />
    </SvgBase>
  )
}

function HelpCircleIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 1 1 5.1 2.1c-.9.8-1.3 1.3-1.3 2.4" />
      <path d="M12 17h.01" />
    </SvgBase>
  )
}

function SettingsIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.36a1.7 1.7 0 0 0-1 .58V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-.58 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-.58-1H4a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 .58-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.1 4.24l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-.58V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 .58 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9c.14.36.34.69.58 1H20a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-.51 1Z" />
    </SvgBase>
  )
}

function ChevronDownIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="m6 9 6 6 6-6" />
    </SvgBase>
  )
}

function ChevronsLeftIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="m11 17-5-5 5-5" />
      <path d="m18 17-5-5 5-5" />
    </SvgBase>
  )
}

function ChevronsRightIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="m13 17 5-5-5-5" />
      <path d="m6 17 5-5-5-5" />
    </SvgBase>
  )
}

function MoreHorizontalIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M5 12h.01" />
      <path d="M12 12h.01" />
      <path d="M19 12h.01" />
    </SvgBase>
  )
}

function ArchiveIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M4 7h16" />
      <path d="M6 7v13h12V7" />
      <path d="M8 4h8l1 3H7l1-3Z" />
      <path d="M10 12h4" />
    </SvgBase>
  )
}

function PlusIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </SvgBase>
  )
}

function XIcon({ className }: SidebarIconProps) {
  return (
    <SvgBase className={className}>
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </SvgBase>
  )
}
