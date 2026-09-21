import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronIcon } from '../../shared/ui/icons'
import { MobileSidebarButton } from '../../shared/ui/sidebar'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { CanonicalWorkItem } from '../api/tasks'
import {
  createTaskSummary,
  taskTabs,
  type TaskSummary,
  type TaskTab,
} from '../model/taskView'
import { createTaskTabId, taskTabPanelId } from './taskTabAccessibility'

/** Props accepted by the task page header. */
export type TaskHeaderProps = {
  /** Currently active task view. */
  activeTab: TaskTab
  /** Whether the displayed Project is currently available from quick access. */
  isProjectQuickAccess: boolean
  /** Whether a quick-access change is currently being persisted. */
  isProjectQuickAccessSaving?: boolean
  /** Whether the inline create form is currently open. */
  isCreateTaskOpen: boolean
  /** Changes the inline create form visibility when creation is permitted. */
  onCreateTaskOpenChange?: (isOpen: boolean) => void
  /** Opens the mobile workspace sidebar. */
  onMobileSidebarOpen: () => void
  /** Adds or removes the displayed Project from quick access. */
  onProjectQuickAccessToggle?: () => void
  /** Selects a task view and returns false when a local guard rejects it. */
  onTabChange: (tab: TaskTab) => boolean | void
  /** Project name shown in the breadcrumb and heading. */
  projectName: string
  /** Resolves localized task labels. */
  t: (key: MessageKey) => string
  /** Complete task collection used by the header counters. */
  tasks: CanonicalWorkItem[]
  /** Team name shown in the breadcrumb. */
  teamName: string
  /** Initial shown in the current-user avatar. */
  userInitial: string
}

/**
 * Renders the project breadcrumb, summary, actions, and accessible task view tabs.
 *
 * @param props - Header labels, tasks, selected tab, and interaction callbacks.
 * @returns The task page header.
 */
export function TaskHeader({
  activeTab,
  isProjectQuickAccess,
  isProjectQuickAccessSaving = false,
  isCreateTaskOpen,
  onCreateTaskOpenChange,
  onMobileSidebarOpen,
  onProjectQuickAccessToggle,
  onTabChange,
  projectName,
  t,
  tasks,
  teamName,
  userInitial,
}: TaskHeaderProps) {
  const taskSummary = createTaskSummary(tasks)
  const quickAccessLabel = t(
    isProjectQuickAccess
      ? 'tasks.action.quickAccessRemove'
      : 'tasks.action.quickAccessAdd',
  )
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

    const accepted = onTabChange(nextTab)
    if (accepted !== false) {
      document.getElementById(createTaskTabId(nextTab))?.focus()
    }
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
                {t('workspace.metric.openTasks')}: {taskSummary.openCount}
              </span>
              <span className="workbench-badge-warning">
                {t('tasks.metric.inProgress')}: {taskSummary.inProgressCount}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-2">
          <IconButton
            isBusy={isProjectQuickAccessSaving}
            isDisabled={!onProjectQuickAccessToggle || isProjectQuickAccessSaving}
            isPressed={isProjectQuickAccess}
            label={quickAccessLabel}
            onClick={onProjectQuickAccessToggle}
          >
            <StarIcon isFilled={isProjectQuickAccess} />
          </IconButton>
          <span className="contents max-[860px]:hidden">
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
                activeTab === tab
                  ? 'text-[var(--workbench-text)]'
                  : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
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
        <SummaryCard summary={taskSummary} t={t} />
      </div>
    </header>
  )
}

/** A metric displayed in the compact project summary. */
type ProjectMetric = {
  /** Translation key for the metric label. */
  labelKey: MessageKey
  /** Formatted metric value. */
  value: string
  /** Percentage used by the progress indicator. */
  progressPercent: number
  /** Tailwind class used by the progress indicator. */
  accentClassName: string
}

/** Props accepted by the compact project summary. */
type SummaryCardProps = {
  /** Aggregate counts calculated for the complete Project task collection. */
  summary: TaskSummary
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders project completion metrics beside the task tabs.
 *
 * @param props - Aggregate task summary and translator.
 * @returns The compact project summary.
 */
function SummaryCard({ summary, t }: SummaryCardProps) {
  const projectMetrics: ProjectMetric[] = [
    {
      labelKey: 'tasks.metric.inProgress',
      value: String(summary.inProgressCount),
      progressPercent: summary.totalCount > 0
        ? Math.round((summary.inProgressCount / summary.totalCount) * 100)
        : 0,
      accentClassName: 'bg-[var(--workbench-primary)]',
    },
    {
      labelKey: 'tasks.metric.done',
      value: String(summary.doneCount),
      progressPercent: summary.completionRate,
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
        <p className="mt-1 text-lg font-semibold leading-none text-[#1c1d1f]">
          {summary.completionRate}%
        </p>
      </div>
      <div className="relative h-10 w-10">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(var(--workbench-primary) 0 ${summary.completionRate}%, var(--workbench-border) ${summary.completionRate}% 100%)`,
          }}
        />
        <div className="absolute inset-[6px] rounded-full bg-white" />
      </div>
    </section>
  )
}

/** Props accepted by a compact icon action. */
type IconButtonProps = {
  /** Icon rendered inside the button. */
  children: ReactNode
  /** Whether the action is waiting for a persisted result. */
  isBusy?: boolean
  /** Whether the action is currently unavailable. */
  isDisabled?: boolean
  /** Pressed state used by toggle buttons. */
  isPressed?: boolean
  /** Accessible button label. */
  label: string
  /** Runs the action represented by the icon. */
  onClick?: () => void
  /** Whether to use a circular shape. */
  rounded?: boolean
}

/** Renders a compact header icon button. */
function IconButton({
  children,
  isBusy = false,
  isDisabled = false,
  isPressed,
  label,
  onClick,
  rounded = false,
}: IconButtonProps) {
  return (
    <button
      aria-busy={isBusy || undefined}
      aria-label={label}
      aria-pressed={isPressed}
      className={`grid h-9 w-9 place-items-center transition focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 disabled:cursor-not-allowed disabled:opacity-50 ${
        isPressed
          ? 'bg-amber-50 text-amber-600 hover:bg-amber-100 hover:text-amber-700'
          : 'text-[#505967] hover:bg-[#f3f4f6] hover:text-[#1c1d1f]'
      } ${
        rounded ? 'rounded-full' : 'rounded-md'
      }`}
      disabled={isDisabled}
      onClick={onClick}
      type="button"
    >
      <span className={isBusy ? 'animate-pulse' : undefined}>{children}</span>
    </button>
  )
}

/** Renders the compact project breadcrumb glyph. */
function ProjectGlyph() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded border border-[#d3d8df] bg-[#f3f4f6] text-app-micro font-semibold text-[#505967]">
      P
    </span>
  )
}

/** Renders the letter glyph associated with a task view tab. */
function TabIcon({ tab }: { /** Task view represented by the glyph. */ tab: TaskTab }) {
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

/** Props accepted by the shared SVG icon shell. */
type IconShellProps = {
  /** SVG path content. */
  children: ReactNode
  /** Optional icon size classes. */
  className?: string
}

/** Renders the common SVG attributes used by header icons. */
function IconShell({ children, className = '' }: IconShellProps) {
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

/** Props accepted by the project quick-access star icon. */
type StarIconProps = {
  /** Whether the star uses a filled treatment. */
  isFilled: boolean
}

/** Renders the outline or filled Project quick-access star. */
function StarIcon({ isFilled }: StarIconProps) {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z"
        fill={isFilled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

/** Renders the more-actions icon. */
function MoreIcon() {
  return <IconShell><path d="M5 12h.01M12 12h.01M19 12h.01" /></IconShell>
}

/** Renders the project sharing icon. */
function UsersMiniIcon() {
  return (
    <IconShell>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </IconShell>
  )
}

/** Renders the add action icon. */
function PlusIcon() {
  return <IconShell><path d="M12 5v14M5 12h14" /></IconShell>
}

/** Renders the notifications icon. */
function BellOutlineIcon() {
  return (
    <IconShell>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </IconShell>
  )
}
