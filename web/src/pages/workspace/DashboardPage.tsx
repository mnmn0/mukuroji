import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  getCurrentUser,
  getDashboardSummary,
  type CurrentUser,
  type DashboardSummary,
} from '../../auth/api'
import { useCurrentUser } from '../../auth/queries/useCurrentUser'
import { useDashboardSummary } from '../../auth/queries/useDashboardSummary'
import { resolveEnterpriseSessionErrorsAction } from '../../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession, type AuthSession } from '../../auth/session'
import { Sidebar } from '../../shared/ui/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../../projects/api'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import { getNotificationUnreadCount } from '../../notifications/api'
import {
  useNotificationUnreadCount,
} from '../../notifications/queries/useNotificationUnreadCount'
import { createProjectIssuesPath } from '../../shared/routing/paths'

/**
 * ダッシュボード上の小さな指標カードに渡す表示値です。
 */
type DashboardStatProps = {
  /**
   * 指標名として表示する i18n 済みラベルです。
   */
  label: string
  /**
   * 指標値として表示する短い文字列です。
   */
  value: string
}

/**
 * DashboardPage が外部の認証/session/API へアクセスするための差し替え可能な依存です。
 */
type DashboardPageProps = {
  /**
   * 保存済み認証セッションを取得する関数です。
   */
  getSession?: () => AuthSession | null
  /**
   * 保存済み認証セッションを削除する関数です。
   */
  clearSession?: () => void
  /**
   * access token から現在のユーザー情報を取得する関数です。
   */
  loadCurrentUser?: (accessToken: string) => Promise<CurrentUser>
  /**
   * access token からダッシュボード集計値を取得する関数です。
   */
  loadDashboardSummary?: (accessToken: string) => Promise<DashboardSummary>
  /**
   * access token から通知の実未読件数を取得する関数です。
   */
  loadNotificationUnreadCount?: (accessToken: string) => Promise<number>
  /**
   * access token からチーム/プロジェクト階層を取得する関数です。
   */
  loadProjectDirectory?: (
    accessToken: string,
    locale: Locale,
  ) => Promise<ProjectDirectoryTeam[]>
  /**
   * Storybook などで初期表示に使うチーム/プロジェクト階層です。
   */
  initialProjectDirectory?: ProjectDirectoryTeam[]
  /**
   * Storybook などで固定したい初期 locale です。
   */
  initialLocale?: Locale
}

const emptyProjectDirectory: ProjectDirectoryTeam[] = []

/**
 * Cognito 認証後に表示するローカル検証用ダッシュボード画面です。
 */
export function DashboardPage({
  getSession = getAuthSession,
  clearSession = clearAuthSession,
  loadCurrentUser = getCurrentUser,
  loadDashboardSummary = getDashboardSummary,
  loadNotificationUnreadCount = getNotificationUnreadCount,
  loadProjectDirectory = getProjectDirectory,
  initialProjectDirectory = emptyProjectDirectory,
  initialLocale,
}: DashboardPageProps = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [session] = useState<AuthSession | null>(() => getSession())
  const [locale] = useState<Locale>(() => initialLocale ?? getInitialLocale())
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const accessToken = session?.accessToken
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken, true, loadCurrentUser)
  const {
    data: summary,
    error: dashboardSummaryError,
    isLoading: isDashboardSummaryLoading,
  } = useDashboardSummary(
    accessToken,
    Boolean(user && !currentUserError),
    loadDashboardSummary,
  )
  const {
    data: inboxCount = 0,
    error: notificationUnreadCountError,
  } = useNotificationUnreadCount(
    accessToken,
    Boolean(user && !currentUserError),
    loadNotificationUnreadCount,
  )
  const { data: loadedProjectDirectory, error: projectDirectoryError } =
    useProjectDirectory({
      accessToken,
      enabled: Boolean(user && !currentUserError),
      loadProjectDirectory,
      locale,
    })
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      dashboardSummaryError,
      notificationUnreadCountError,
      projectDirectoryError,
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const teams = loadedProjectDirectory ?? initialProjectDirectory
  const isLoading = !session ||
    isCurrentUserLoading ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay')

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('dashboard.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => {
    if (!session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (currentUserErrorAction?.redirectTo) {
      if (currentUserErrorAction.clearSession) {
        clearSession()
      }
      navigate(currentUserErrorAction.redirectTo, { replace: true })
    }
  }, [
    clearSession,
    currentUserErrorAction?.clearSession,
    currentUserErrorAction?.redirectTo,
    navigate,
  ])

  const handleLogout = () => {
    clearSession()
    navigate('/', { replace: true })
  }

  const displayName =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? ''
  const projectCount = isDashboardSummaryLoading ? '...' : String(summary?.projects ?? 0)
  const taskCount = isDashboardSummaryLoading ? '...' : String(summary?.tasks ?? 0)
  const blockedCount = isDashboardSummaryLoading ? '...' : String(summary?.blocked ?? 0)

  return (
    <main className="workbench-shell flex min-h-svh">
      <Sidebar
        activeNavId="dashboard"
        className="max-[900px]:hidden"
        inboxCount={inboxCount}
        labels={sidebarLabels}
        onSelectProject={(projectId, teamId) =>
          navigate(createProjectIssuesPath(projectId, teamId))
        }
        teams={teams}
      />

      <section className="min-w-0 flex-1 px-[clamp(20px,4vw,48px)] py-[clamp(20px,4vw,36px)]">
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] pb-5">
          <div className="min-w-0">
            <p className="workbench-eyebrow">
              {t('dashboard.authProvider')}
            </p>
            <h1 className="workbench-title mt-2 text-dashboard-title">
              {t('dashboard.title')}
            </h1>
            <p className="workbench-description mt-2 max-w-[620px]">
              {t('dashboard.subtitle')}
            </p>
          </div>

          <button
            className="workbench-button-secondary min-h-10 px-4"
            type="button"
            onClick={handleLogout}
          >
            {t('dashboard.logout')}
          </button>
        </header>

        {currentUserErrorAction?.kind === 'stay' ? (
          <p
            className="mt-7 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
            role="alert"
          >
            {t('dashboard.loadError')}
          </p>
        ) : isLoading ? (
          <p className="mt-7 text-sm font-medium text-[var(--workbench-muted)]">
            {t('dashboard.loading')}
          </p>
        ) : (
          <div className="mt-7 grid gap-5">
            <section className="workbench-panel p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {t('dashboard.signedInAs')}
              </p>
              <p className="mt-2 break-all text-xl font-semibold text-[var(--workbench-text)]">
                {displayName}
              </p>
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">
                {t('dashboard.authProviderValue')}
              </p>
            </section>

            <div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">
              <DashboardStat
                label={t('dashboard.stat.projects')}
                value={projectCount}
              />
              <DashboardStat label={t('dashboard.stat.tasks')} value={taskCount} />
              <DashboardStat
                label={t('dashboard.stat.blocked')}
                value={blockedCount}
              />
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

/**
 * ラベル付きの指標カードを描画する DashboardPage 内部コンポーネントです。
 *
 * @param props - 表示ラベルと値を持つ `DashboardStatProps` です。
 * @returns 指標カードの JSX element です。
 */
function DashboardStat({ label, value }: DashboardStatProps) {
  return (
    <section className="workbench-panel p-4">
      <p className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</p>
      <p className="mt-2 text-3xl font-semibold leading-none text-[var(--workbench-text)]">
        {value}
      </p>
    </section>
  )
}
