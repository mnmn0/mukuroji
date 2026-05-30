import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  getCurrentUser,
  getDashboardSummary,
  type CurrentUser,
  type DashboardSummary,
} from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import { Sidebar, type SidebarTeam } from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../i18n'

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

const fallbackDashboardSummary = {
  projects: 3,
  tasks: 18,
  blocked: 2,
} as const

/**
 * Cognito 認証後に表示するローカル検証用ダッシュボード画面です。
 */
export function DashboardPage() {
  const navigate = useNavigate()
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSummaryLoading, setIsSummaryLoading] = useState(true)
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const teams = useMemo<SidebarTeam[]>(
    () => [
      {
        id: 'core-team',
        name: t('dashboard.team.core'),
        expanded: true,
        projects: [
          {
            id: 'product-roadmap',
            name: t('dashboard.project.productRoadmap'),
            tone: 'blue',
          },
          {
            id: 'release-plan',
            name: t('dashboard.project.releasePlan'),
            tone: 'green',
          },
          {
            id: 'customer-feedback',
            name: t('dashboard.project.customerFeedback'),
            tone: 'purple',
          },
        ],
      },
      {
        id: 'design-team',
        name: t('dashboard.team.design'),
      },
    ],
    [t],
  )

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('dashboard.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => {
    let isMounted = true
    const session = getAuthSession()

    if (!session) {
      navigate('/', { replace: true })
      return () => {
        isMounted = false
      }
    }

    getCurrentUser(session.accessToken)
      .then((currentUser) => {
        if (isMounted) {
          setUser(currentUser)
        }
      })
      .catch(() => {
        if (isMounted) {
          clearAuthSession()
          navigate('/', { replace: true })
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false)
        }
      })

    getDashboardSummary(session.accessToken)
      .then((dashboardSummary) => {
        if (isMounted) {
          setSummary(dashboardSummary)
        }
      })
      .catch(() => {
        if (isMounted) {
          setSummary(null)
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsSummaryLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [navigate])

  const handleLogout = () => {
    clearAuthSession()
    navigate('/', { replace: true })
  }

  const displayName =
    user?.attributes.email ?? user?.attributes.name ?? user?.username ?? ''
  const dashboardSummary = summary ?? fallbackDashboardSummary
  const projectCount = isSummaryLoading ? '...' : String(dashboardSummary.projects)
  const taskCount = isSummaryLoading ? '...' : String(dashboardSummary.tasks)
  const blockedCount = isSummaryLoading ? '...' : String(dashboardSummary.blocked)

  return (
    <main className="flex min-h-svh bg-[var(--surface)]">
      <Sidebar
        activeNavId="dashboard"
        className="max-[900px]:hidden"
        inboxCount={2}
        labels={sidebarLabels}
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
