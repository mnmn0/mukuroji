import type {
  PlanningHealth,
  PlanningUpdateState,
  PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { formatPlanningUpdateDate } from '../../planning/model/date'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createPlanningPath,
  createPlanningProjectUpdatePath,
  createProjectIssuesPath,
  createTeamViewPath,
  workspaceNavPaths,
} from '../../shared/routing/paths'
import { ProgressBar } from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectDirectoryProject, ProjectDirectoryTeam } from '../api/directory'
import {
  resolveProjectOverviewMemberName,
  type ProjectOverviewMembers,
  type ProjectOverviewSchedule,
  type ProjectOverviewWorkItemSummary,
} from '../model/projectOverview'

/** Why the Project's Work Item counts are not shown. */
export type ProjectOverviewWorkItemsError = 'load' | 'limit'

/** Props for the pure Project overview view. */
export type ProjectOverviewViewProps = {
  /** Locale used to format dates. */
  locale: Locale
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Team that owns the Project, when the route names a readable one. */
  team?: ProjectDirectoryTeam
  /** Project shown by the overview, when the viewer can read it. */
  project?: ProjectDirectoryProject
  /** Work Item counts, absent while loading or after a failed read. */
  workItemSummary?: ProjectOverviewWorkItemSummary
  /** Why the Work Item counts are missing, when they failed. */
  workItemsError?: ProjectOverviewWorkItemsError
  /** Whether the Work Item counts are still loading. */
  isWorkItemsLoading: boolean
  /** The Project's update target from the Planning snapshot. */
  updateTarget?: PlanningUpdateTargetSummary
  /** The Project's Phases, Milestones, and Releases, absent while loading or after a failure. */
  schedule?: ProjectOverviewSchedule
  /** Whether the Planning snapshot failed to load. */
  isPlanningError: boolean
  /** Whether the Planning snapshot is still loading. */
  isPlanningLoading: boolean
  /** Project members grouped by role, absent while loading or after a failure. */
  members?: ProjectOverviewMembers
  /** Whether the Project members failed to load. */
  isMembersError: boolean
  /** Whether the Project members are still loading. */
  isMembersLoading: boolean
  /** Reads the Project Work Items again after a failure. */
  onRetryWorkItems?: () => void
  /** Reads the Planning snapshot again after a failure. */
  onRetryPlanning?: () => void
  /** Reads the Project members again after a failure. */
  onRetryMembers?: () => void
}

/** Badge tokens for reported Project health. */
const healthClassNames: Record<PlanningHealth, string> = {
  unknown: 'border-slate-200 bg-slate-50 text-fg-slate-600',
  'on-track': 'border-emerald-200 bg-emerald-50 text-fg-emerald-700',
  'at-risk': 'border-amber-200 bg-amber-50 text-fg-amber-800',
  'off-track': 'border-red-200 bg-red-50 text-fg-red-700',
}

/** Badge tokens for Project update freshness. */
const updateStateClassNames: Record<PlanningUpdateState, string> = {
  'not-configured': 'border-slate-200 bg-slate-50 text-fg-slate-600',
  missing: 'border-slate-300 bg-surface text-fg-slate-700',
  current: 'border-emerald-200 bg-emerald-50 text-fg-emerald-700',
  stale: 'border-amber-200 bg-amber-50 text-fg-amber-800',
  overdue: 'border-red-200 bg-red-50 text-fg-red-700',
}

const linkClassName =
  'inline-flex min-h-9 items-center text-sm font-semibold text-[var(--workbench-primary-text)] underline-offset-4 hover:underline focus-visible:underline'

/**
 * Renders one Project's profile, health, progress, schedule, members, and related views.
 *
 * @param props - Data already read for the Project, its load states, and labels.
 * @returns The pure Project overview.
 */
export function ProjectOverviewView({
  isMembersError,
  isMembersLoading,
  isPlanningError,
  isPlanningLoading,
  isWorkItemsLoading,
  locale,
  members,
  onRetryMembers,
  onRetryPlanning,
  onRetryWorkItems,
  project,
  schedule,
  t,
  team,
  updateTarget,
  workItemSummary,
  workItemsError,
}: ProjectOverviewViewProps) {
  if (!team || !project) {
    return (
      <p
        className="workbench-panel px-5 py-4 text-sm font-semibold text-[var(--workbench-muted)]"
        data-testid="project-overview-missing"
        role="status"
      >
        {t(team ? 'projects.overview.missing' : 'projects.overview.teamMissing')}
      </p>
    )
  }

  const charter = project.charter
  const lifecycleState = project.lifecycleState ?? 'active'
  const period = charter?.plannedStartDate || charter?.plannedEndDate
    ? `${charter.plannedStartDate ?? '—'} – ${charter.plannedEndDate ?? '—'}`
    : t('projects.overview.profile.periodUnset')

  return (
    <div className="grid gap-5" data-testid="project-overview">
      <section className="workbench-panel grid gap-4 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--workbench-muted)]">{team.name}</p>
          <h2
            className="mt-1 break-words text-xl font-semibold text-[var(--workbench-text)]"
            data-testid="project-overview-name"
          >
            {project.name}
          </h2>
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm min-[600px]:grid-cols-2 min-[1000px]:grid-cols-4">
          <ProfileItem label={t('projects.overview.profile.code')}>
            {charter?.code ?? '—'}
          </ProfileItem>
          <ProfileItem label={t('projects.overview.profile.owner')}>
            {charter?.owner?.displayName ?? t('projects.overview.profile.ownerUnset')}
          </ProfileItem>
          <ProfileItem label={t('projects.overview.profile.period')}>{period}</ProfileItem>
          <ProfileItem label={t('projects.overview.profile.lifecycle')}>
            {t(`projects.lifecycle.${lifecycleState}`)}
          </ProfileItem>
        </dl>
      </section>

      <div className="grid gap-5 min-[1000px]:grid-cols-2">
        <OverviewSection testId="project-overview-health" title={t('projects.overview.health.title')}>
          <HealthContent
            isError={isPlanningError}
            isLoading={isPlanningLoading}
            locale={locale}
            onRetry={onRetryPlanning}
            t={t}
            updateTarget={updateTarget}
          />
          <Link className={linkClassName} to={createPlanningProjectUpdatePath(team.id, project.id)}>
            {t('projects.overview.health.openUpdate')}
          </Link>
        </OverviewSection>

        <OverviewSection testId="project-overview-progress" title={t('projects.overview.progress.title')}>
          <ProgressContent
            error={workItemsError}
            isLoading={isWorkItemsLoading}
            onRetry={onRetryWorkItems}
            projectName={project.name}
            summary={workItemSummary}
            t={t}
          />
          <Link className={linkClassName} to={createProjectIssuesPath(project.id, team.id)}>
            {t('projects.overview.progress.openWorkItems')}
          </Link>
        </OverviewSection>

        <OverviewSection
          meta={schedule && schedule.delayedCount > 0
            ? t('projects.overview.schedule.delayedCount').replace('{count}', String(schedule.delayedCount))
            : undefined}
          testId="project-overview-schedule"
          title={t('projects.overview.schedule.title')}
        >
          <ScheduleContent
            isError={isPlanningError}
            isLoading={isPlanningLoading}
            onRetry={onRetryPlanning}
            schedule={schedule}
            t={t}
          />
          <Link className={linkClassName} to={createPlanningPath('timeline')}>
            {t('projects.overview.schedule.openTimeline')}
          </Link>
        </OverviewSection>

        <OverviewSection
          meta={members
            ? t('projects.overview.members.total').replace('{count}', String(members.totalCount))
            : undefined}
          testId="project-overview-members"
          title={t('projects.overview.members.title')}
        >
          <MembersContent
            isError={isMembersError}
            isLoading={isMembersLoading}
            members={members}
            onRetry={onRetryMembers}
            t={t}
          />
        </OverviewSection>
      </div>

      <nav
        aria-label={t('projects.overview.links.title')}
        className="workbench-panel flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3"
        data-testid="project-overview-links"
      >
        <span className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('projects.overview.links.title')}
        </span>
        <Link className={linkClassName} to={createTeamViewPath(team.id, 'factory')}>
          {t('projects.overview.links.factory')}
        </Link>
        <Link className={linkClassName} to={workspaceNavPaths.documents}>
          {t('projects.overview.links.documents')}
        </Link>
      </nav>
    </div>
  )
}

/** Props for one labeled profile value. */
type ProfileItemProps = {
  /** Visible label. */
  label: string
  /** Value shown under the label. */
  children: ReactNode
}

/**
 * Renders one profile label and value.
 *
 * @param props - Label and value.
 * @returns A description list entry.
 */
function ProfileItem({ children, label }: ProfileItemProps) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-[var(--workbench-muted)]">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-[var(--workbench-text)]">{children}</dd>
    </div>
  )
}

/** Props for one overview widget. */
type OverviewSectionProps = {
  /** Widget content. */
  children: ReactNode
  /** Optional supporting text beside the title. */
  meta?: string
  /** Stable test identifier. */
  testId: string
  /** Widget heading. */
  title: string
}

/**
 * Renders one titled overview widget.
 *
 * @param props - Title, optional meta text, and content.
 * @returns A labeled section.
 */
function OverviewSection({ children, meta, testId, title }: OverviewSectionProps) {
  const headingId = `${testId}-heading`
  return (
    <section
      aria-labelledby={headingId}
      className="workbench-panel grid min-w-0 content-start gap-3 px-5 py-4"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-[var(--workbench-text)]" id={headingId}>{title}</h3>
        {meta ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{meta}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** Props for a loading or error message inside a widget. */
type StatusTextProps = {
  /** Message text. */
  children: ReactNode
  /** Whether the message reports a failure. */
  isError?: boolean
  /** Reads the failed data again, when the failure is retryable. */
  onRetry?: () => void
  /** Resolves localized labels, required with `onRetry`. */
  t?: (key: MessageKey) => string
}

/**
 * Renders a loading, empty, or failure message inside a widget.
 *
 * @param props - Message and whether it is a failure.
 * @returns A status paragraph.
 */
function StatusText({ children, isError = false, onRetry, t }: StatusTextProps) {
  return (
    <div
      className={isError
        ? 'flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-fg-amber-800'
        : 'text-sm font-medium text-[var(--workbench-muted)]'}
      role={isError ? 'alert' : undefined}
    >
      <p>{children}</p>
      {isError && onRetry && t ? (
        <button
          className="workbench-button-secondary inline-flex h-9 items-center px-3 text-sm"
          onClick={onRetry}
          type="button"
        >
          {t('workspace.error.retry')}
        </button>
      ) : null}
    </div>
  )
}

/** Props for the health widget content. */
type HealthContentProps = {
  /** Whether the Planning snapshot failed. */
  isError: boolean
  /** Whether the Planning snapshot is loading. */
  isLoading: boolean
  /** Locale used to format dates. */
  locale: Locale
  /** Reads the Planning snapshot again after a failure. */
  onRetry?: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** The Project's update target. */
  updateTarget?: PlanningUpdateTargetSummary
}

/**
 * Renders the latest reported health, freshness, summary, and next due date.
 *
 * @param props - Update target and load state.
 * @returns Health widget content.
 */
function HealthContent({ isError, isLoading, locale, onRetry, t, updateTarget }: HealthContentProps) {
  if (isError) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.planning')}</StatusText>
  }
  if (isLoading) return <StatusText>{t('projects.overview.loading')}</StatusText>

  const latest = updateTarget?.latestUpdate
  const health = latest?.health ?? 'unknown'
  const updateState = updateTarget?.updateState ?? 'not-configured'
  const nextDueAt = updateTarget?.cadence?.nextDueAt
  const timeZone = updateTarget?.cadence?.timeZone

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${healthClassNames[health]}`}
          data-testid="project-overview-health-badge"
        >
          {t(`planning.health.${health}`)}
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${updateStateClassNames[updateState]}`}>
          {t(`planning.updateState.${updateState}`)}
        </span>
        {latest ? (
          <span className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('projects.overview.health.risk')}: {t(`planning.risk.${latest.risk}`)}
          </span>
        ) : null}
      </div>
      <p className="break-words text-sm font-medium text-[var(--workbench-text)]">
        {latest?.summary || t('planning.updateState.neverUpdated')}
      </p>
      <p className="text-xs font-medium text-[var(--workbench-muted)]">
        {nextDueAt
          ? t('planning.updateState.dueMeta').replace(
              '{date}',
              formatPlanningUpdateDate(nextDueAt, timeZone, locale),
            )
          : t('planning.updateState.noDueDate')}
      </p>
    </div>
  )
}

/** Props for the progress widget content. */
type ProgressContentProps = {
  /** Why the counts are missing, when they failed. */
  error?: ProjectOverviewWorkItemsError
  /** Whether the counts are loading. */
  isLoading: boolean
  /** Reads the Work Items again after a retryable failure. */
  onRetry?: () => void
  /** Project name used in the progress bar label. */
  projectName: string
  /** Work Item counts. */
  summary?: ProjectOverviewWorkItemSummary
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders completion and Work Item counts, including attention counts.
 *
 * @param props - Counts and load state.
 * @returns Progress widget content.
 */
function ProgressContent({ error, isLoading, onRetry, projectName, summary, t }: ProgressContentProps) {
  if (error) {
    // Reading again cannot fix a list over the read limit, so only a load failure offers it.
    return (
      <StatusText isError onRetry={error === 'load' ? onRetry : undefined} t={t}>
        {t(error === 'limit' ? 'projects.overview.error.workItemsLimit' : 'projects.overview.error.workItems')}
      </StatusText>
    )
  }
  if (isLoading || !summary) return <StatusText>{t('projects.overview.loading')}</StatusText>

  const counts: ReadonlyArray<readonly [MessageKey, number, string]> = [
    ['projects.overview.progress.total', summary.totalCount, 'total'],
    ['projects.overview.progress.open', summary.openCount, 'open'],
    ['projects.overview.progress.inProgress', summary.inProgressCount, 'in-progress'],
    ['projects.overview.progress.done', summary.doneCount, 'done'],
    ['projects.overview.progress.overdue', summary.overdueCount, 'overdue'],
    ['projects.overview.progress.highPriority', summary.highPriorityOpenCount, 'high-priority'],
  ]

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3 text-sm font-semibold">
          <span className="text-[var(--workbench-muted)]">{t('projects.overview.progress.completion')}</span>
          <span className="tabular-nums text-[var(--workbench-text)]">{summary.completionRate}%</span>
        </div>
        <ProgressBar
          label={`${projectName} ${t('projects.overview.progress.completion')}`}
          value={summary.completionRate}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm min-[600px]:grid-cols-3">
        {counts.map(([labelKey, value, token]) => (
          <div className="min-w-0" data-testid={`project-overview-count-${token}`} key={token}>
            <dt className="text-xs font-medium text-[var(--workbench-muted)]">{t(labelKey)}</dt>
            <dd
              className={`text-lg font-semibold tabular-nums ${
                (token === 'overdue' || token === 'high-priority') && value > 0
                  ? 'text-fg-red-700'
                  : 'text-[var(--workbench-text)]'
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Props for the schedule widget content. */
type ScheduleContentProps = {
  /** Whether the Planning snapshot failed. */
  isError: boolean
  /** Whether the Planning snapshot is loading. */
  isLoading: boolean
  /** Reads the Planning snapshot again after a failure. */
  onRetry?: () => void
  /** The Project's bounded schedule. */
  schedule?: ProjectOverviewSchedule
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the Project's Phases, Milestones, and Releases with their forecast variance.
 *
 * @param props - Bounded schedule and load state.
 * @returns Schedule widget content.
 */
function ScheduleContent({ isError, isLoading, onRetry, schedule, t }: ScheduleContentProps) {
  if (isError) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.planning')}</StatusText>
  }
  if (isLoading || !schedule) return <StatusText>{t('projects.overview.loading')}</StatusText>
  if (schedule.items.length === 0) return <StatusText>{t('projects.overview.schedule.empty')}</StatusText>

  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {schedule.items.map((item) => {
          const variance = item.delayDays > 0
            ? t('projects.overview.schedule.late').replace('{days}', String(item.delayDays))
            : item.delayDays < 0
              ? t('projects.overview.schedule.early').replace('{days}', String(-item.delayDays))
              : t('projects.overview.schedule.onTime')
          return (
            <li
              className="grid gap-1 rounded-md border border-[var(--workbench-border)] px-3 py-2"
              data-testid={`project-overview-schedule-${item.id}`}
              key={item.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  className="min-w-0 break-words text-sm font-semibold text-[var(--workbench-text)] underline-offset-4 hover:underline focus-visible:underline"
                  to={createPlanningPath('timeline', item.id)}
                >
                  {item.title}
                </Link>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${healthClassNames[item.health]}`}>
                  {t(`planning.health.${item.health}`)}
                </span>
              </div>
              <p className="flex flex-wrap gap-x-3 text-xs font-medium text-[var(--workbench-muted)]">
                <span>{t(`planning.type.${item.type}`)}</span>
                <span>{t('projects.overview.schedule.due').replace('{date}', item.forecastEndDate)}</span>
                <span className={item.delayDays > 0 ? 'font-semibold text-fg-red-700' : undefined}>
                  {variance}
                </span>
                <span className="tabular-nums">{item.progress}%</span>
              </p>
            </li>
          )
        })}
      </ul>
      {schedule.hiddenCount > 0 ? (
        <StatusText>
          {t('projects.overview.schedule.hidden').replace('{count}', String(schedule.hiddenCount))}
        </StatusText>
      ) : null}
    </div>
  )
}

/** Props for the members widget content. */
type MembersContentProps = {
  /** Whether the members failed to load. */
  isError: boolean
  /** Whether the members are loading. */
  isLoading: boolean
  /** Members grouped by role. */
  members?: ProjectOverviewMembers
  /** Reads the members again after a failure. */
  onRetry?: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the member count per role and the bounded member list.
 *
 * @param props - Member summary and load state.
 * @returns Members widget content.
 */
function MembersContent({ isError, isLoading, members, onRetry, t }: MembersContentProps) {
  if (isError) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.members')}</StatusText>
  }
  if (isLoading || !members) return <StatusText>{t('projects.overview.loading')}</StatusText>
  if (members.totalCount === 0) return <StatusText>{t('projects.overview.members.empty')}</StatusText>

  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
        <span>{t('workspace.permissions.role.manager')}: {members.roleCounts.manager}</span>
        <span>{t('workspace.permissions.role.member')}: {members.roleCounts.member}</span>
        <span>{t('workspace.permissions.role.viewer')}: {members.roleCounts.viewer}</span>
      </p>
      <ul className="grid gap-1.5">
        {members.shown.map((member) => (
          <li className="flex min-w-0 items-center justify-between gap-3 text-sm" key={member.id}>
            <span className="min-w-0 truncate font-medium text-[var(--workbench-text)]">
              {resolveProjectOverviewMemberName(member)}
            </span>
            <span className="flex-none text-xs font-semibold text-[var(--workbench-muted)]">
              {t(`workspace.permissions.role.${member.role}`)}
            </span>
          </li>
        ))}
      </ul>
      {members.hiddenCount > 0 ? (
        <StatusText>
          {t('projects.overview.members.hidden').replace('{count}', String(members.hiddenCount))}
        </StatusText>
      ) : null}
    </div>
  )
}
