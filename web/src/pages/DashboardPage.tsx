import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { getCurrentUser, type CurrentUser } from '../auth/api'
import { clearAuthSession, getAuthSession } from '../auth/session'
import { ChevronIcon } from '../components/icons'
import { Sidebar, type SidebarTeam } from '../components/sidebar'
import {
  createSidebarLabels,
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../i18n'

/**
 * タスクの進捗状態を表す表示用コードです。
 */
type TaskStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * タスクの優先度を表す表示用コードです。
 */
type TaskPriority = 'high' | 'medium' | 'low'

/**
 * プロジェクト画面のテーブルへ表示するタスク行です。
 */
type ProjectTask = {
  /**
   * React の key として使う一意なタスク ID です。
   */
  id: string
  /**
   * タスク名を解決する i18n key です。
   */
  titleKey: MessageKey
  /**
   * 担当者名を解決する i18n key です。
   */
  assigneeKey: MessageKey
  /**
   * タスクの状態コードです。
   */
  status: TaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度コードです。
   */
  priority: TaskPriority
}

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

const projectTasks: ProjectTask[] = [
  {
    id: 'wireframe',
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'in-progress',
    dueDate: '2025/05/26',
    priority: 'high',
  },
  {
    id: 'brand-guideline',
    titleKey: 'tasks.item.brandGuideline',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'review',
    dueDate: '2025/05/27',
    priority: 'medium',
  },
  {
    id: 'pricing-content',
    titleKey: 'tasks.item.pricingContent',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'in-progress',
    dueDate: '2025/05/28',
    priority: 'high',
  },
  {
    id: 'seo-research',
    titleKey: 'tasks.item.seoResearch',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2025/05/29',
    priority: 'medium',
  },
  {
    id: 'hero-design',
    titleKey: 'tasks.item.heroDesign',
    assigneeKey: 'tasks.assignee.sato',
    status: 'review',
    dueDate: '2025/05/30',
    priority: 'medium',
  },
  {
    id: 'analytics-tags',
    titleKey: 'tasks.item.analyticsTags',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'in-progress',
    dueDate: '2025/06/02',
    priority: 'low',
  },
  {
    id: 'competitor-report',
    titleKey: 'tasks.item.competitorReport',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'done',
    dueDate: '2025/06/03',
    priority: 'low',
  },
  {
    id: 'terms-page',
    titleKey: 'tasks.item.termsPage',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2025/06/04',
    priority: 'medium',
  },
  {
    id: 'faq-content',
    titleKey: 'tasks.item.faqContent',
    assigneeKey: 'tasks.assignee.sato',
    status: 'todo',
    dueDate: '2025/06/05',
    priority: 'low',
  },
  {
    id: 'landing-release',
    titleKey: 'tasks.item.landingRelease',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'todo',
    dueDate: '2025/06/06',
    priority: 'high',
  },
]

/**
 * プロジェクトのタスク画面を描画するための props です。
 */
type ProjectTaskScreenProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * ユーザーアバターに表示する頭文字です。
   */
  userInitial: string
  /**
   * 認証確認中の loading 表示に切り替えるかどうかです。
   */
  isLoading?: boolean
}

/**
 * Cognito 認証後に表示するプロジェクトタスク画面です。
 */
export function DashboardPage() {
  const navigate = useNavigate()
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('tasks.project.refero')} | ${t('app.title')}`
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

    return () => {
      isMounted = false
    }
  }, [navigate])

  const userInitial =
    (user?.attributes.name ?? user?.attributes.email ?? user?.username ?? 'J')
      .trim()
      .charAt(0)
      .toUpperCase() || 'J'

  return <ProjectTaskScreen isLoading={isLoading} locale={locale} userInitial={userInitial} />
}

/**
 * サイドバー、プロジェクトヘッダー、タスクテーブルを含むタスク管理画面です。
 */
export function ProjectTaskScreen({
  locale,
  userInitial,
  isLoading = false,
}: ProjectTaskScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sidebarLabels = useMemo(() => createSidebarLabels(locale), [locale])
  const teams = useMemo<SidebarTeam[]>(
    () => [
      {
        id: 'johns-first-team',
        name: t('tasks.team.johnsFirstTeam'),
        expanded: true,
        projects: [
          { id: 'refero', name: t('tasks.project.refero'), tone: 'blue' },
          { id: 'marketing', name: t('tasks.project.marketing'), tone: 'purple' },
          {
            id: 'customer-stories',
            name: t('tasks.project.customerStories'),
            tone: 'green',
          },
          {
            id: 'product-roadmap',
            name: t('tasks.project.productRoadmap'),
            tone: 'yellow',
          },
        ],
      },
      {
        id: 'design-team',
        name: t('tasks.team.designTeam'),
      },
      {
        id: 'sales-team',
        name: t('tasks.team.salesTeam'),
      },
    ],
    [t],
  )

  return (
    <main className="flex min-h-svh overflow-hidden bg-[#f6f9fd] text-[#0d1833]">
      <Sidebar
        activeProjectId="refero"
        className="max-[980px]:hidden"
        inboxCount={3}
        labels={sidebarLabels}
        teams={teams}
      />

      <section className="flex min-w-0 flex-1 flex-col bg-white/80">
        <ProjectHeader t={t} userInitial={userInitial} />

        {isLoading ? (
          <div className="grid min-h-[360px] place-items-center px-6 text-base font-bold text-slate-500">
            {t('dashboard.loading')}
          </div>
        ) : (
          <ProjectWorkspace t={t} />
        )}
      </section>
    </main>
  )
}

function ProjectHeader({
  t,
  userInitial,
}: {
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * ユーザーアバターに表示する頭文字です。
   */
  userInitial: string
}) {
  return (
    <header className="border-b border-slate-200/80 bg-white/95 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="flex min-h-[90px] items-center justify-between gap-5 px-[clamp(22px,3vw,38px)] py-4">
        <div className="min-w-0">
          <nav className="flex flex-wrap items-center gap-3 text-[15px] font-medium text-[#405174]" aria-label={t('tasks.breadcrumb.aria')}>
            <span>{t('tasks.team.johnsFirstTeam')}</span>
            <ChevronIcon className="h-4 w-4 -rotate-90 text-[#61708f]" />
            <span className="inline-flex items-center gap-2 font-black text-[#0d1833]">
              <ProjectGlyph />
              {t('tasks.project.refero')}
            </span>
          </nav>
          <div className="mt-3 flex min-w-0 items-center gap-4">
            <h1 className="truncate text-[clamp(30px,3vw,42px)] font-black leading-none tracking-[-0.04em] text-[#0d1833]">
              {t('tasks.project.refero')}
            </h1>
            <button className="text-[#526381] transition hover:text-blue-600" type="button" aria-label={t('tasks.action.favorite')}>
              <StarIcon />
            </button>
            <button className="text-[#526381] transition hover:text-blue-600" type="button" aria-label={t('tasks.action.more')}>
              <MoreIcon />
            </button>
          </div>
        </div>

        <div className="flex flex-none items-center gap-3 max-[860px]:hidden">
          <label className="relative block">
            <span className="sr-only">{t('tasks.search')}</span>
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#526381]" />
            <input
              className="h-12 w-[220px] rounded-xl border border-slate-300 bg-white pl-12 pr-4 text-sm font-bold text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] outline-none transition placeholder:text-[#71809a] focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              placeholder={t('tasks.search')}
              type="search"
            />
          </label>
          <button className="inline-flex h-12 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-black text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600" type="button">
            <UsersMiniIcon />
            {t('tasks.action.share')}
          </button>
          <button className="inline-flex h-12 items-center gap-3 rounded-xl bg-blue-600 px-5 text-sm font-black text-white shadow-[0_14px_30px_rgba(37,99,235,0.28)] transition hover:bg-blue-500" type="button">
            <PlusIcon />
            {t('tasks.action.newTask')}
            <ChevronIcon className="h-4 w-4" />
          </button>
          <button className="grid h-12 w-12 place-items-center rounded-full text-[#334463] transition hover:bg-slate-100" type="button" aria-label={t('tasks.action.notifications')}>
            <BellOutlineIcon />
          </button>
          <div className="grid h-12 w-12 place-items-center rounded-full bg-blue-100 text-base font-black text-blue-700" aria-label={t('tasks.userAvatar')}>
            {userInitial}
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-5 overflow-x-auto px-[clamp(22px,3vw,38px)]">
        <div className="flex min-w-max items-center gap-1">
          {(['table', 'board', 'gantt', 'calendar', 'file'] as const).map((tab) => (
            <button
              className={`relative inline-flex h-[76px] items-center gap-2 px-5 text-sm font-black transition ${
                tab === 'table' ? 'text-blue-600' : 'text-[#405174] hover:text-blue-600'
              }`}
              key={tab}
              type="button"
            >
              <TabIcon tab={tab} />
              {t(`tasks.tab.${tab}`)}
              {tab === 'table' ? (
                <span className="absolute inset-x-2 bottom-0 h-1 rounded-t-full bg-blue-600" aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
        <SummaryCard t={t} />
      </div>
    </header>
  )
}

function ProjectWorkspace({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#fbfdff] px-[clamp(22px,3vw,38px)] py-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <FilterButton icon={<FilterIcon />} label={t('tasks.filter.all')} />
          <FilterButton icon={<StatusIcon />} label={t('tasks.filter.status')} />
          <FilterButton icon={<AssigneeIcon />} label={t('tasks.filter.assignee')} />
          <FilterButton icon={<CalendarIcon />} label={t('tasks.filter.dueDate')} />
          <FilterButton icon={<FlagIcon />} label={t('tasks.filter.priority')} />
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <p className="text-sm font-black text-[#0d1833]">
            {t('tasks.sort.dueDate')}{' '}
            <span className="text-xl leading-none" aria-hidden="true">
              ↑
            </span>
          </p>
          <button className="inline-flex h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 text-sm font-black text-[#0d1833] shadow-[0_10px_24px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600" type="button">
            <SettingsMiniIcon />
            {t('tasks.viewSettings')}
          </button>
        </div>
      </div>

      <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_22px_54px_rgba(30,52,88,0.06)]" aria-label={t('tasks.table.aria')}>
        <div className="min-w-[980px]">
          <div className="grid grid-cols-[minmax(410px,1.5fr)_190px_170px_170px_160px_64px] border-b border-slate-200 bg-white px-7 py-4 text-sm font-black text-[#0d1833]">
            <div className="flex items-center gap-2">
              {t('tasks.column.name')}
              <span className="text-[#526381]" aria-hidden="true">↕</span>
            </div>
            <div>{t('tasks.column.assignee')}</div>
            <div>{t('tasks.column.status')}</div>
            <div>{t('tasks.column.dueDate')}</div>
            <div>{t('tasks.column.priority')}</div>
            <div className="text-center text-xl text-[#526381]">+</div>
          </div>

          {projectTasks.map((task) => (
            <TaskRow key={task.id} task={task} t={t} />
          ))}

          <div className="grid grid-cols-[1fr_auto] items-center border-t border-slate-200 px-7 py-4 text-sm font-bold">
            <button className="inline-flex items-center gap-2 text-blue-600 transition hover:text-blue-500" type="button">
              <PlusIcon className="h-5 w-5" />
              {t('tasks.addTask')}
            </button>
            <span className="text-[#526381]">{t('tasks.count')}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

function SummaryCard({ t }: { t: (key: MessageKey) => string }) {
  const doneCount = projectTasks.filter((task) => task.status === 'done').length
  const inProgressCount = projectTasks.filter((task) => task.status === 'in-progress').length
  const completionRate = Math.round((doneCount / projectTasks.length) * 100)
  const projectMetrics: ProjectMetric[] = [
    {
      labelKey: 'tasks.metric.inProgress',
      value: String(inProgressCount),
      progressPercent: Math.round((inProgressCount / projectTasks.length) * 100),
      accentClassName: 'bg-blue-600',
    },
    {
      labelKey: 'tasks.metric.done',
      value: String(doneCount),
      progressPercent: completionRate,
      accentClassName: 'bg-emerald-500',
    },
  ]

  return (
    <section className="mb-4 flex min-w-[500px] items-center rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-[0_18px_42px_rgba(30,52,88,0.08)] max-[1280px]:hidden" aria-label={t('tasks.summary.aria')}>
      {projectMetrics.map((metric) => (
        <div className="min-w-[120px] border-r border-slate-200 px-2" key={metric.labelKey}>
          <p className="text-sm font-black text-[#263550]">{t(metric.labelKey)}</p>
          <p className="mt-2 text-3xl font-black leading-none text-blue-600">{metric.value}</p>
          <div className="mt-3 h-1 rounded-full bg-slate-200">
            <div className={`h-1 rounded-full ${metric.accentClassName}`} style={{ width: `${metric.progressPercent}%` }} />
          </div>
        </div>
      ))}
      <div className="px-5">
        <p className="text-sm font-black text-[#263550]">{t('tasks.metric.completionRate')}</p>
        <p className="mt-2 text-3xl font-black leading-none text-[#0d1833]">{completionRate}%</p>
      </div>
      <div className="relative h-[72px] w-[72px]">
        <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(#2563eb 0 ${completionRate}%, #dce2ea ${completionRate}% 100%)` }} />
        <div className="absolute inset-[11px] rounded-full bg-white" />
      </div>
    </section>
  )
}

function FilterButton({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button className="inline-flex h-12 min-w-[128px] items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 text-sm font-black text-[#0d1833] shadow-[0_10px_24px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600" type="button">
      <span className="inline-flex items-center gap-3">
        {icon}
        {label}
      </span>
      <ChevronIcon className="h-4 w-4" />
    </button>
  )
}

function TaskRow({ task, t }: { task: ProjectTask; t: (key: MessageKey) => string }) {
  const statusClasses: Record<TaskStatus, string> = {
    'in-progress': 'bg-blue-100 text-blue-700',
    review: 'bg-orange-100 text-orange-600',
    todo: 'bg-slate-100 text-[#263550]',
    done: 'bg-emerald-100 text-emerald-700',
  }
  const priorityClasses: Record<TaskPriority, string> = {
    high: 'bg-red-100 text-red-600',
    medium: 'bg-orange-100 text-orange-600',
    low: 'bg-emerald-100 text-emerald-700',
  }

  return (
    <div className="grid grid-cols-[minmax(410px,1.5fr)_190px_170px_170px_160px_64px] items-center border-b border-slate-200 px-7 py-3.5 text-[15px] font-bold text-[#0d1833] last:border-b-0 hover:bg-blue-50/40">
      <div className="flex min-w-0 items-center gap-4">
        <input className="h-5 w-5 rounded border-slate-300 text-blue-600" type="checkbox" aria-label={t(task.titleKey)} />
        <span className="min-w-0 truncate">{t(task.titleKey)}</span>
      </div>
      <div>{t(task.assigneeKey)}</div>
      <div>
        <span className={`inline-flex rounded-lg px-4 py-2 text-sm font-black ${statusClasses[task.status]}`}>
          {t(`tasks.status.${task.status}`)}
        </span>
      </div>
      <div className={task.status === 'done' ? 'text-[#405174] line-through' : task.dueDate === '2025/05/26' ? 'text-red-600' : ''}>
        {task.dueDate}
      </div>
      <div>
        <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-black ${priorityClasses[task.priority]}`}>
          <FlagIcon className="h-4 w-4" />
          {t(`tasks.priority.${task.priority}`)}
        </span>
      </div>
      <div />
    </div>
  )
}

function ProjectGlyph() {
  return <span className="grid h-5 w-5 place-items-center rounded-md border border-blue-500 text-[11px] font-black text-blue-600">▤</span>
}

function TabIcon({ tab }: { tab: 'table' | 'board' | 'gantt' | 'calendar' | 'file' }) {
  const icons = {
    table: '⌘',
    board: '▯',
    gantt: '≋',
    calendar: '□',
    file: '♧',
  }
  return <span className="text-xl leading-none">{icons[tab]}</span>
}

function IconShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <svg className={className || 'h-5 w-5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}

function SearchIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return <IconShell className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></IconShell>
}

function StarIcon() {
  return <IconShell><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z" /></IconShell>
}

function MoreIcon() {
  return <IconShell><path d="M5 12h.01M12 12h.01M19 12h.01" /></IconShell>
}

function UsersMiniIcon() {
  return <IconShell><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></IconShell>
}

function PlusIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return <IconShell className={className}><path d="M12 5v14M5 12h14" /></IconShell>
}

function BellOutlineIcon() {
  return <IconShell><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></IconShell>
}

function FilterIcon() {
  return <IconShell><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" /></IconShell>
}

function StatusIcon() {
  return <IconShell><path d="M6 14a6 6 0 1 0 12 0" /><path d="M12 2v6" /><path d="M8 6h8" /></IconShell>
}

function AssigneeIcon() {
  return <IconShell><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></IconShell>
}

function CalendarIcon() {
  return <IconShell><path d="M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" /></IconShell>
}

function FlagIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return <IconShell className={className}><path d="M5 21V5" /><path d="M5 5h12l-1.5 4L17 13H5" /></IconShell>
}

function SettingsMiniIcon() {
  return <IconShell><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-.4-1 1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1-.4 1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 .4 1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1 .4h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1 .4 1.7 1.7 0 0 0-.6 1Z" /></IconShell>
}
