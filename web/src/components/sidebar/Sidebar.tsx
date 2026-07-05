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
  | 'my-tasks'
  | 'inbox'
  | 'dashboard'
  | 'reports'
  | 'help'
  | 'settings'

/**
 * チーム配下で選択できる固定ビューです。
 */
export type SidebarTeamViewId = 'overview' | 'issues' | 'members'

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
   */
  activeProjectTeamId?: string
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
  /**
   * 受信箱の未読件数です。
   */
  inboxCount?: number
  /**
   * サイドバーに表示するチーム一覧です。
   */
  teams: SidebarTeam[]
  /**
   * ルート要素へ追加する CSS class です。
   */
  className?: string
  /**
   * 折りたたみ状態が変わったときに呼ばれます。
   */
  onCollapsedChange?: (collapsed: boolean) => void
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
   * チームが選択されたときに呼ばれます。
   */
  onSelectTeam?: (teamId: string) => void
  /**
   * プロジェクトが選択されたときに呼ばれます。
   */
  onSelectProject?: (projectId: string, teamId: string) => void
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

const mainNavItems: MainNavItem[] = [
  { id: 'home', icon: HomeIcon },
  { id: 'my-tasks', icon: CheckCircleIcon },
  { id: 'inbox', icon: BellIcon },
  { id: 'dashboard', icon: DashboardIcon },
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
  },
  teamOverview: 'チーム概要',
  issues: 'Issues',
  members: 'メンバー',
  projectGroup: 'プロジェクト',
  unreadCount: (count) => `${count}件の未読`,
  nav: {
    home: 'ホーム',
    'my-tasks': 'マイタスク',
    inbox: '受信箱',
    dashboard: 'ダッシュボード',
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
  inboxCount = 0,
  teams,
  className = '',
  onCollapsedChange,
  onCreateTeam,
  onCreateProject,
  onArchiveTeam,
  onArchiveProject,
  onSelectNav,
  onSelectTeamView,
  onSelectTeam,
  onSelectProject,
  onExpandedTeamIdsChange,
}: SidebarProps) {
  const resolvedLabels = resolveLabels(labels)
  const defaultProjectTeamId = defaultActiveProjectId
    ? defaultActiveProjectTeamId ?? findProjectTeamId(teams, defaultActiveProjectId)
    : undefined
  const shouldSelectInitialProject =
    controlledActiveNavId === undefined && defaultActiveNavId === undefined
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
  const createButtonRef = useRef<HTMLButtonElement>(null)

  const isCollapsed = controlledCollapsed ?? internalCollapsed
  const activeProjectId = controlledActiveProjectId ?? internalActiveProjectId
  const activeProjectTeamId = controlledActiveProjectTeamId ?? internalActiveProjectTeamId
  const projectTeamId = activeProjectId
    ? activeProjectTeamId ?? findProjectTeamId(teams, activeProjectId)
    : undefined
  const activeTeamViewId = controlledActiveTeamViewId ?? internalActiveTeamViewId
  const activeTeamId = controlledActiveTeamId ?? projectTeamId ?? internalActiveTeamId
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

  const navItems = mainNavItems.map((item) =>
    item.id === 'inbox' ? { ...item, badge: inboxCount } : item,
  )
  const canCreate = Boolean(onCreateTeam || onCreateProject)
  const createDialogId = useId()

  const archiveTeam = (teamId: string) => {
    if (!onArchiveTeam || archivingItemKey) {
      return
    }

    const itemKey = createTeamArchiveKey(teamId)

    setArchiveErrorMessage(undefined)
    setArchivingItemKey(itemKey)
    void Promise.resolve()
      .then(() => onArchiveTeam(teamId))
      .catch(() => {
        setArchiveErrorMessage(resolvedLabels.archive.error)
      })
      .finally(() => {
        setArchivingItemKey(undefined)
      })
  }

  const archiveProject = (teamId: string, projectId: string) => {
    if (!onArchiveProject || archivingItemKey) {
      return
    }

    const itemKey = createProjectArchiveKey(teamId, projectId)

    setArchiveErrorMessage(undefined)
    setArchivingItemKey(itemKey)
    void Promise.resolve()
      .then(() => onArchiveProject(teamId, projectId))
      .catch(() => {
        setArchiveErrorMessage(resolvedLabels.archive.error)
      })
      .finally(() => {
        setArchivingItemKey(undefined)
      })
  }

  const updateCollapsed = (nextCollapsed: boolean) => {
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(nextCollapsed)
    }
    onCollapsedChange?.(nextCollapsed)
  }

  const updateActiveNav = (navId: SidebarNavId) => {
    if (controlledActiveNavId === undefined) {
      setInternalActiveNavId(navId)
    }
    if (controlledActiveTeamId === undefined) {
      setInternalActiveTeamId(undefined)
    }
    if (controlledActiveTeamViewId === undefined) {
      setInternalActiveTeamViewId(undefined)
    }
    if (controlledActiveProjectId === undefined) {
      setInternalActiveProjectId(undefined)
    }
    if (controlledActiveProjectTeamId === undefined) {
      setInternalActiveProjectTeamId(undefined)
    }
    onSelectNav?.(navId)
  }

  const updateActiveTeam = (teamId: string) => {
    if (controlledActiveNavId === undefined) {
      setInternalActiveNavId(undefined)
    }
    if (controlledActiveTeamId === undefined) {
      setInternalActiveTeamId(teamId)
    }
    if (controlledActiveTeamViewId === undefined) {
      setInternalActiveTeamViewId(undefined)
    }
    if (controlledActiveProjectId === undefined) {
      setInternalActiveProjectId(undefined)
    }
    if (controlledActiveProjectTeamId === undefined) {
      setInternalActiveProjectTeamId(undefined)
    }
    onSelectTeam?.(teamId)
  }

  const updateActiveProject = (projectId: string, teamId: string) => {
    const team = teams.find((candidate) => candidate.id === teamId)

    if (team) {
      if (controlledActiveTeamId === undefined) {
        setInternalActiveTeamId(team.id)
      }
      updateExpandedTeamIds(ensureIncludes(expandedTeamIds, team.id))
    }

    if (controlledActiveNavId === undefined) {
      setInternalActiveNavId(undefined)
    }
    if (controlledActiveTeamViewId === undefined) {
      setInternalActiveTeamViewId(undefined)
    }
    if (controlledActiveProjectId === undefined) {
      setInternalActiveProjectId(projectId)
    }
    if (controlledActiveProjectTeamId === undefined) {
      setInternalActiveProjectTeamId(teamId)
    }
    onSelectProject?.(projectId, teamId)
  }

  const updateActiveTeamView = (teamId: string, viewId: SidebarTeamViewId) => {
    if (controlledActiveNavId === undefined) {
      setInternalActiveNavId(undefined)
    }
    if (controlledActiveTeamId === undefined) {
      setInternalActiveTeamId(teamId)
    }
    if (controlledActiveTeamViewId === undefined) {
      setInternalActiveTeamViewId(viewId)
    }
    if (controlledActiveProjectId === undefined) {
      setInternalActiveProjectId(undefined)
    }
    if (controlledActiveProjectTeamId === undefined) {
      setInternalActiveProjectTeamId(undefined)
    }
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

  const toggleTeam = (teamId: string) => {
    const isExpanded = expandedTeamIds.includes(teamId)
    const nextTeamIds = isExpanded
      ? expandedTeamIds.filter((expandedTeamId) => expandedTeamId !== teamId)
      : [...expandedTeamIds, teamId]

    if (controlledExpandedTeamIds === undefined) {
      setInternalCollapsedTeamIds((currentTeamIds) =>
        isExpanded
          ? ensureIncludes(currentTeamIds, teamId)
          : currentTeamIds.filter((expandedTeamId) => expandedTeamId !== teamId),
      )
    }

    updateActiveTeam(teamId)
    updateExpandedTeamIds(nextTeamIds)
  }

  const openCreateModal = () => {
    setCreateModalDefaultMode(resolveDefaultCreateMode(teams, onCreateTeam, onCreateProject))
    setIsCreateModalOpen(true)
  }

  return (
    <>
      <aside
        className={`flex h-dvh max-h-dvh min-h-0 flex-none flex-col overflow-hidden bg-[var(--workbench-sidebar)] py-4 text-white shadow-[1px_0_0_rgba(255,255,255,0.08)] transition-all duration-200 min-[981px]:h-svh min-[981px]:max-h-svh ${isCollapsed ? 'w-[76px] px-3' : 'w-[292px] max-w-[calc(100vw-32px)] px-4'} ${className}`}
        aria-label={resolvedLabels.ariaLabel}
        data-collapsed={isCollapsed}
        inert={isCreateModalOpen ? true : undefined}
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

        {!isCollapsed ? (
          <div className="mt-6 flex flex-none items-center justify-between px-1 text-app-meta font-semibold text-slate-200">
            <span className="truncate">{resolvedLabels.teamProjects}</span>
            {canCreate ? (
              <button
                ref={createButtonRef}
                className={`grid h-8 w-8 place-items-center rounded-lg text-slate-100 transition hover:bg-white/10 ${isCreateModalOpen ? 'bg-white/10 text-white' : ''}`}
                type="button"
                aria-controls={isCreateModalOpen ? createDialogId : undefined}
                aria-expanded={isCreateModalOpen}
                aria-haspopup="dialog"
                aria-label={resolvedLabels.create.title}
                title={resolvedLabels.create.title}
                onClick={openCreateModal}
              >
                <PlusIcon className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <div className={isCollapsed ? 'space-y-1' : 'space-y-2'}>
            {teams.map((team) => (
              <TeamGroup
                key={team.id}
                team={team}
                activeTeamId={activeTeamId}
                activeTeamViewId={activeTeamViewId}
                activeProjectId={activeProjectId}
                activeProjectTeamId={activeProjectTeamId}
                projectTeamId={projectTeamId}
                labels={resolvedLabels}
                collapsed={isCollapsed}
                expanded={expandedTeamIds.includes(team.id)}
                archivingItemKey={archivingItemKey}
                onArchiveProject={onArchiveProject ? archiveProject : undefined}
                onArchiveTeam={onArchiveTeam ? archiveTeam : undefined}
                onToggleTeam={toggleTeam}
                onSelectTeamView={updateActiveTeamView}
                onSelectProject={updateActiveProject}
              />
            ))}
          </div>
          {archiveErrorMessage && !isCollapsed ? (
            <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/12 px-3 py-2 text-app-caption font-bold leading-5 text-red-100" role="alert">
              {archiveErrorMessage}
            </p>
          ) : null}
        </div>

        <nav className="mt-3 flex-none space-y-1 border-t border-white/10 pt-3" aria-label={resolvedLabels.utilityNavigation}>
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
    </>
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
      className="fixed inset-0 z-50 grid place-items-center bg-[#020b18]/55 px-4 py-6 text-[#0d1833] backdrop-blur-sm"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="w-full max-w-[480px] overflow-hidden rounded-lg bg-white shadow-[0_26px_80px_rgba(3,23,47,0.34)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        id={dialogId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[#dce5f2] bg-[#f8fbff] px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-[20px] font-semibold leading-tight text-[#0b1735]">
              {labels.title}
            </h2>
            <button
              className="grid h-9 w-9 flex-none place-items-center rounded-lg text-[#526381] transition hover:bg-[#eaf1fb] hover:text-[#0b1735] disabled:cursor-not-allowed disabled:opacity-50"
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
              className="mt-4 grid grid-cols-2 rounded-lg bg-[#eaf1fb] p-1"
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
              <label className="grid gap-2 text-[13px] font-semibold text-[#233456]">
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
              <label className="grid gap-2 text-[13px] font-semibold text-[#233456]">
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
              <label className="grid gap-2 text-[13px] font-semibold text-[#233456]">
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
                <legend className="text-[13px] font-semibold text-[#233456]">{labels.tone}</legend>
                <div className="grid grid-cols-4 gap-2">
                  {projectToneOptions.map((tone) => (
                    <label
                      className={`grid h-10 cursor-pointer place-items-center rounded-lg border transition focus-within:border-[var(--workbench-primary)] focus-within:ring-3 focus-within:ring-[#99d7cf]/35 ${
                        selectedTone === tone
                          ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] ring-3 ring-[#99d7cf]/35'
                          : 'border-[#cbd8ea] bg-white hover:bg-[#f5f8fc]'
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
          ? 'bg-white text-[#0b1735] shadow-[0_8px_22px_rgba(23,44,75,0.12)]'
          : 'text-[#526381] hover:bg-white/60 hover:text-[#0b1735]'
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

function TeamGroup({
  team,
  activeTeamId,
  activeTeamViewId,
  activeProjectId,
  activeProjectTeamId,
  projectTeamId,
  labels,
  collapsed,
  expanded,
  archivingItemKey,
  onArchiveTeam,
  onArchiveProject,
  onToggleTeam,
  onSelectTeamView,
  onSelectProject,
}: {
  team: SidebarTeam
  activeTeamId?: string
  activeTeamViewId?: SidebarTeamViewId
  activeProjectId?: string
  activeProjectTeamId?: string
  projectTeamId?: string
  labels: SidebarLabels
  collapsed: boolean
  expanded: boolean
  archivingItemKey?: string
  onArchiveTeam?: (teamId: string) => void
  onArchiveProject?: (teamId: string, projectId: string) => void
  onToggleTeam: (teamId: string) => void
  onSelectTeamView: (teamId: string, viewId: SidebarTeamViewId) => void
  onSelectProject?: (projectId: string, teamId: string) => void
}) {
  const isTeamActive = activeTeamId === team.id
  const isProjectAncestor = projectTeamId === team.id && activeProjectId !== undefined
  const isCurrentTeam = isTeamActive && !activeProjectId && !activeTeamViewId

  return (
    <div>
      <div className="relative">
        {isTeamActive || isProjectAncestor ? (
          <span className="absolute inset-y-0 left-0 w-1 rounded-full bg-teal-400" aria-hidden="true" />
        ) : null}
        <div className={`flex items-center gap-1 ${collapsed ? 'justify-center' : ''}`}>
          <button
            className={`group flex h-9 min-w-0 flex-1 items-center gap-3 rounded-lg py-2 text-left text-app-body font-medium transition ${collapsed ? 'justify-center px-0' : 'pl-3 pr-2'} ${
              isCurrentTeam
                ? 'bg-teal-500/20 text-white shadow-[inset_0_0_0_1px_rgba(45,212,191,0.14)]'
                : isTeamActive || isProjectAncestor
                  ? 'bg-white/8 text-white'
                  : 'text-slate-100 hover:bg-white/10 hover:text-white'
            }`}
            type="button"
            aria-current={isCurrentTeam ? 'page' : undefined}
            aria-expanded={collapsed ? undefined : expanded}
            aria-label={collapsed ? team.name : undefined}
            title={collapsed ? team.name : undefined}
            onClick={() => onToggleTeam(team.id)}
          >
            <UsersIcon className="h-5 w-5 flex-none text-slate-100" />
            <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{team.name}</span>
            {collapsed ? null : isCurrentTeam ? (
              <MoreHorizontalIcon className="h-5 w-5 flex-none text-slate-200" />
            ) : (
              <ChevronDownIcon
                className={`h-4 w-4 flex-none text-slate-200 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
              />
            )}
          </button>
          {!collapsed && onArchiveTeam ? (
            <ArchiveButton
              disabled={Boolean(archivingItemKey)}
              isArchiving={archivingItemKey === createTeamArchiveKey(team.id)}
              label={labels.archive.team(team.name)}
              loadingLabel={labels.archive.archiving}
              onClick={() => onArchiveTeam(team.id)}
            />
          ) : null}
        </div>
      </div>

      {!collapsed && expanded ? (
        <div className="mt-1.5 space-y-0.5 pl-8">
          <SubNavButton
            active={isTeamActive && activeTeamViewId === 'overview'}
            icon={PanelIcon}
            label={labels.teamOverview}
            onClick={() => onSelectTeamView(team.id, 'overview')}
          />
          <SubNavButton
            active={isTeamActive && activeTeamViewId === 'issues'}
            icon={CheckCircleIcon}
            label={labels.issues}
            onClick={() => onSelectTeamView(team.id, 'issues')}
          />
          <SubNavButton
            active={isTeamActive && activeTeamViewId === 'members'}
            icon={UsersIcon}
            label={labels.members}
            onClick={() => onSelectTeamView(team.id, 'members')}
          />
          <div className="flex h-7 items-center gap-2 px-1 text-app-meta font-medium text-slate-100">
            <ChevronDownIcon className="h-4 w-4 flex-none" />
            <span className="truncate">{labels.projectGroup}</span>
          </div>
          <div className="space-y-1 pl-5">
            {team.projects?.map((project) => (
              <ProjectButton
                key={project.id}
                project={project}
                active={
                  project.id === activeProjectId &&
                  (activeProjectTeamId === undefined || activeProjectTeamId === team.id)
                }
                archivingItemKey={archivingItemKey}
                archiveLabels={labels.archive}
                teamId={team.id}
                onArchiveProject={onArchiveProject}
                onSelectProject={(projectId) => onSelectProject?.(projectId, team.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SubNavButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ComponentType<SidebarIconProps>
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`relative flex h-7 w-full items-center gap-3 rounded-lg px-1 text-left text-app-meta font-medium transition hover:bg-white/10 hover:text-white ${
        active ? 'bg-teal-500/20 text-white' : 'text-slate-100'
      }`}
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {active ? (
        <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-teal-400" aria-hidden="true" />
      ) : null}
      <Icon className="h-[18px] w-[18px] flex-none text-slate-100" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function ProjectButton({
  project,
  active,
  archivingItemKey,
  archiveLabels,
  teamId,
  onArchiveProject,
  onSelectProject,
}: {
  project: SidebarProject
  active: boolean
  archivingItemKey?: string
  archiveLabels: SidebarArchiveLabels
  teamId: string
  onArchiveProject?: (teamId: string, projectId: string) => void
  onSelectProject?: (projectId: string) => void
}) {
  const tone = project.tone ?? 'blue'

  return (
    <div className="flex items-center gap-1">
      <button
        className={`relative flex h-8 min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pl-3 pr-2 text-left text-app-meta font-medium transition ${
          active
            ? 'bg-teal-500/20 text-white shadow-[inset_0_0_0_1px_rgba(45,212,191,0.14)]'
            : 'text-slate-100 hover:bg-white/10 hover:text-white'
        }`}
        type="button"
        onClick={() => onSelectProject?.(project.id)}
        aria-current={active ? 'page' : undefined}
      >
        {active ? (
          <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-teal-400" aria-hidden="true" />
        ) : null}
        <span
          className={`grid h-[17px] w-[17px] flex-none place-items-center rounded-[4px] border ${projectToneClasses[tone]}`}
          aria-hidden="true"
        >
          <span className="h-[7px] w-[8px] rounded-[2px] border border-current" />
        </span>
        <span className="min-w-0 truncate">{project.name}</span>
      </button>
      {onArchiveProject ? (
        <ArchiveButton
          disabled={Boolean(archivingItemKey)}
          isArchiving={archivingItemKey === createProjectArchiveKey(teamId, project.id)}
          label={archiveLabels.project(project.name)}
          loadingLabel={archiveLabels.archiving}
          onClick={() => onArchiveProject(teamId, project.id)}
        />
      ) : null}
    </div>
  )
}

function ArchiveButton({
  disabled,
  isArchiving,
  label,
  loadingLabel,
  onClick,
}: {
  disabled: boolean
  isArchiving: boolean
  label: string
  loadingLabel: string
  onClick: () => void
}) {
  const accessibleLabel = isArchiving ? loadingLabel : label

  return (
    <button
      className="grid h-8 w-8 flex-none place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:text-slate-500"
      type="button"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <ArchiveIcon className={`h-4 w-4 ${isArchiving ? 'animate-pulse' : ''}`} />
    </button>
  )
}

function createTeamArchiveKey(teamId: string) {
  return `team:${teamId}`
}

function createProjectArchiveKey(teamId: string, projectId: string) {
  return `project:${teamId}:${projectId}`
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
