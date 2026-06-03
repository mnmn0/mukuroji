import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import useSWR from 'swr'
import {
  getCurrentUser,
  getDashboardSummary,
  type CurrentUser,
  type DashboardSummary,
} from '../auth/api'
import { clearAuthSession, getAuthSession, type AuthSession } from '../auth/session'
import { Sidebar } from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../i18n'
import {
  getProjectDirectory,
  type ProjectDirectoryTeam,
} from '../projects/api'
import { createProjectTasksPath } from '../routes/paths'

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

const apiSWRConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Cognito 認証後に表示するローカル検証用ダッシュボード画面です。
 */
export function DashboardPage({
  getSession = getAuthSession,
  clearSession = clearAuthSession,
  loadCurrentUser = getCurrentUser,
  loadDashboardSummary = getDashboardSummary,
  loadProjectDirectory = getProjectDirectory,
  initialProjectDirectory = emptyProjectDirectory,
  initialLocale,
}: DashboardPageProps = {}) {
  const navigate = useNavigate()
  const [session] = useState<AuthSession | null>(() => getSession())
  const [locale] = useState<Locale>(() => initialLocale ?? getInitialLocale())
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const accessToken = session?.accessToken
  const currentUserKey = accessToken ? (['current-user', accessToken] as const) : null
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useSWR(
    currentUserKey,
    ([, accessToken]) => loadCurrentUser(accessToken),
    apiSWRConfig,
  )
  const dashboardSummaryKey = accessToken && user && !currentUserError
    ? (['dashboard-summary', accessToken] as const)
    : null
  const { data: summary, isLoading: isDashboardSummaryLoading } = useSWR(
    dashboardSummaryKey,
    ([, accessToken]) => loadDashboardSummary(accessToken),
    apiSWRConfig,
  )
  const projectDirectoryKey = accessToken && user && !currentUserError
    ? (['project-directory', accessToken, locale] as const)
    : null
  const { data: loadedProjectDirectory } = useSWR(
    projectDirectoryKey,
    ([, accessToken, currentLocale]) =>
      loadProjectDirectory(accessToken, currentLocale),
    apiSWRConfig,
  )
  const teams = loadedProjectDirectory ?? initialProjectDirectory
  const isLoading = !session || isCurrentUserLoading || Boolean(currentUserError)

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
    if (currentUserError) {
      clearSession()
      navigate('/', { replace: true })
    }
  }, [clearSession, currentUserError, navigate])

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
    <main className="flex min-h-svh bg-[var(--surface)]">
      <Sidebar
        activeNavId="dashboard"
        className="max-[900px]:hidden"
        inboxCount={summary?.blocked ?? 0}
        labels={sidebarLabels}
        onSelectProject={(projectId, teamId) =>
          navigate(createProjectTasksPath(projectId, teamId))
        }
        teams={teams}
      />

      <section className="min-w-0 flex-1 px-[clamp(20px,4vw,54px)] py-[clamp(24px,4vw,46px)]">
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-5 border-b border-[#dce5f0] pb-7">
          <div className="min-w-0">
            <p className="text-sm font-black uppercase tracking-normal text-[#0063ed]">
              {t('dashboard.authProvider')}
            </p>
            <h1 className="mt-3 text-[clamp(32px,4vw,48px)] font-black leading-tight text-[var(--ink)]">
              {t('dashboard.title')}
            </h1>
            <p className="mt-3 max-w-[620px] text-base font-bold leading-7 text-[var(--muted-strong)]">
              {t('dashboard.subtitle')}
            </p>
          </div>

          <button
            className="min-h-11 rounded-lg border border-[#cbd8e8] bg-white px-5 text-sm font-black text-[var(--ink)] shadow-[0_10px_22px_rgba(28,53,88,0.07)] hover:border-[#0063ed] hover:text-[#0054ca] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(0,101,238,0.18)]"
            type="button"
            onClick={handleLogout}
          >
            {t('dashboard.logout')}
          </button>
        </header>

        {isLoading ? (
          <p className="mt-9 text-base font-bold text-[var(--muted)]">
            {t('dashboard.loading')}
          </p>
        ) : (
          <div className="mt-9 grid gap-6">
            <section className="rounded-lg border border-[#d9e1eb] bg-white p-6 shadow-[0_22px_50px_rgba(28,53,88,0.07)]">
              <p className="text-sm font-black uppercase tracking-normal text-[#66758a]">
                {t('dashboard.signedInAs')}
              </p>
              <p className="mt-3 break-all text-2xl font-black text-[var(--ink)]">
                {displayName}
              </p>
              <p className="mt-2 text-sm font-bold text-[var(--muted)]">
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
    <section className="rounded-lg border border-[#d9e1eb] bg-white p-5 shadow-[0_16px_34px_rgba(28,53,88,0.06)]">
      <p className="text-sm font-black text-[var(--muted)]">{label}</p>
      <p className="mt-2 text-4xl font-black leading-none text-[var(--ink)]">
        {value}
      </p>
    </section>
  )
}
