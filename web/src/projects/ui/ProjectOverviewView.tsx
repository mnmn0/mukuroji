import {
  FACTORY_BOARD_LANES,
  type FactoryBoardLane,
  type ProjectRaidEntryKind,
  type ProjectRaidSeverity,
  type PlanningHealth,
  type PlanningUpdateState,
  type PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { formatPlanningUpdateDate } from '../../planning/model/date'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createDocumentPath,
  createPlanningPath,
  createPlanningProjectUpdatePath,
  createProjectIssuesPath,
  createTeamViewPath,
} from '../../shared/routing/paths'
import { ProgressBar } from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectDirectoryProject, ProjectDirectoryTeam } from '../api/directory'
import {
  resolveProjectOverviewMemberName,
  type ProjectOverviewActionItems,
  type ProjectOverviewAgentRuns,
  type ProjectOverviewDocuments,
  type ProjectOverviewMembers,
  type ProjectOverviewRaid,
  type ProjectOverviewRaidItem,
  type ProjectOverviewSchedule,
  type ProjectOverviewWorkItemSummary,
} from '../model/projectOverview'

/** Why the Project's Work Item counts are not shown. */
export type ProjectOverviewWorkItemsError = 'load' | 'limit'

/** Why the Project members could not be shown: a failed read, or a role that may not read them. */
export type ProjectOverviewMembersError = 'load' | 'denied'

/** Why the Agent Run lane counts could not be shown: a failed read, or a role that may not read the board. */
export type ProjectOverviewAgentRunsError = 'load' | 'denied'

/** Why the Project log could not be shown: a failed read, or a role that may not read it. */
export type ProjectOverviewRaidError = 'load' | 'denied'

/** Why the related Documents could not be shown: a failed read, or a role that may not read them. */
export type ProjectOverviewDocumentsError = 'load' | 'denied'

/** Props for the pure Project overview view. */
export type ProjectOverviewViewProps = {
  /** Actions shown next to the Project name, such as opening the status report. */
  headerActions?: ReactNode
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
  /** Why the Project members could not be shown, absent when they loaded or are loading. */
  membersError?: ProjectOverviewMembersError
  /** Whether the Project members are still loading. */
  isMembersLoading: boolean
  /** Whether to show the Agent Run lane counts, which only Software factory deployments serve. */
  showAgentRuns?: boolean
  /** Agent Run lane counts of the Project, absent while loading or after a failure. */
  agentRuns?: ProjectOverviewAgentRuns
  /** Why the Agent Run lane counts could not be shown, absent when they loaded or are loading. */
  agentRunsError?: ProjectOverviewAgentRunsError
  /** Whether the Team's Factory board is still loading. */
  isAgentRunsLoading?: boolean
  /** Open risks, issues, and recent decisions of the Project log, absent while loading or after a failure. */
  raid?: ProjectOverviewRaid
  /** Why the Project log could not be shown, absent when it loaded or is loading. */
  raidError?: ProjectOverviewRaidError
  /** Whether the Project log is still loading. */
  isRaidLoading?: boolean
  /** Documents related to the Project, absent while loading or after every source failed. */
  documents?: ProjectOverviewDocuments
  /** Why some related Documents could not be shown, absent when every source loaded or is loading. */
  documentsError?: ProjectOverviewDocumentsError
  /** Whether the related Documents are still loading. */
  isDocumentsLoading?: boolean
  /** Reads the Project Work Items again after a failure. */
  onRetryWorkItems?: () => void
  /** Reads the Project log again after a failure. */
  onRetryRaid?: () => void
  /** Reads the related Documents again after a failure. */
  onRetryDocuments?: () => void
  /** Open checklist items in the Project's pages, absent while loading or after a failure. */
  actionItems?: ProjectOverviewActionItems
  /** Why the open action items could not be shown, absent when they loaded or are loading. */
  actionItemsError?: ProjectOverviewDocumentsError
  /** Whether the open action items are still loading. */
  isActionItemsLoading?: boolean
  /** Reads the open action items again after a failure. */
  onRetryActionItems?: () => void
  /** Reads the Planning snapshot again after a failure. */
  onRetryPlanning?: () => void
  /** Reads the Project members again after a failure. */
  onRetryMembers?: () => void
  /** Reads the Team's Factory board again after a failure. */
  onRetryAgentRuns?: () => void
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

/** Badge tokens for the severity of a log entry. */
const severityClassNames: Record<ProjectRaidSeverity, string> = {
  low: 'border-slate-200 bg-slate-50 text-fg-slate-700',
  medium: 'border-amber-200 bg-amber-50 text-fg-amber-800',
  high: 'border-orange-200 bg-orange-50 text-fg-orange-700',
  critical: 'border-red-200 bg-red-50 text-fg-red-700',
}

/** Message keys of the log entry kinds. */
const raidKindMessageKeys: Record<ProjectRaidEntryKind, MessageKey> = {
  risk: 'projects.raidLog.kind.risk',
  issue: 'projects.raidLog.kind.issue',
  'change-request': 'projects.raidLog.kind.changeRequest',
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
  actionItems,
  actionItemsError,
  agentRuns,
  agentRunsError,
  documents,
  documentsError,
  headerActions,
  isActionItemsLoading = false,
  isAgentRunsLoading = false,
  isDocumentsLoading = false,
  isRaidLoading = false,
  isMembersLoading,
  isPlanningError,
  isPlanningLoading,
  isWorkItemsLoading,
  locale,
  members,
  membersError,
  onRetryActionItems,
  onRetryAgentRuns,
  onRetryDocuments,
  onRetryMembers,
  onRetryPlanning,
  onRetryRaid,
  onRetryWorkItems,
  project,
  raid,
  raidError,
  schedule,
  showAgentRuns = true,
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
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">{team.name}</p>
            <h2
              className="mt-1 break-words text-xl font-semibold text-[var(--workbench-text)]"
              data-testid="project-overview-name"
            >
              {project.name}
            </h2>
          </div>
          {headerActions}
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
            error={membersError}
            isLoading={isMembersLoading}
            members={members}
            onRetry={onRetryMembers}
            t={t}
          />
        </OverviewSection>

        <OverviewSection testId="project-overview-raid" title={t('projects.overview.raid.title')}>
          <RaidContent
            error={raidError}
            isLoading={isRaidLoading}
            locale={locale}
            onRetry={onRetryRaid}
            raid={raid}
            t={t}
          />
          <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('projects.overview.raid.manageHint')}</p>
          <Link className={linkClassName} to={createProjectIssuesPath(project.id, team.id)}>
            {t('projects.overview.raid.openLog')}
          </Link>
        </OverviewSection>

        <OverviewSection testId="project-overview-documents" title={t('projects.overview.documents.title')}>
          <DocumentsContent
            documents={documents}
            error={documentsError}
            isLoading={isDocumentsLoading}
            onRetry={onRetryDocuments}
            t={t}
          />
          <Link className={linkClassName} to={createDocumentPath(undefined, project.id)}>
            {t('projects.overview.documents.openDocuments')}
          </Link>
        </OverviewSection>

        <OverviewSection
          meta={actionItems && actionItems.items.length > 0
            ? t('projects.overview.actionItems.total')
              .replace('{count}', String(actionItems.items.length + actionItems.hiddenCount))
            : undefined}
          testId="project-overview-action-items"
          title={t('projects.overview.actionItems.title')}
        >
          <ActionItemsContent
            actionItems={actionItems}
            error={actionItemsError}
            isLoading={isActionItemsLoading}
            onRetry={onRetryActionItems}
            t={t}
          />
        </OverviewSection>

        {showAgentRuns ? (
          <OverviewSection
            meta={agentRuns
              ? t('projects.overview.agentRuns.total').replace('{count}', String(agentRuns.totalCount))
              : undefined}
            testId="project-overview-agent-runs"
            title={t('projects.overview.agentRuns.title')}
          >
            <AgentRunsContent
              agentRuns={agentRuns}
              error={agentRunsError}
              isLoading={isAgentRunsLoading}
              onRetry={onRetryAgentRuns}
              t={t}
            />
            <Link className={linkClassName} to={createTeamViewPath(team.id, 'factory')}>
              {t('projects.overview.agentRuns.openFactory')}
            </Link>
          </OverviewSection>
        ) : null}
      </div>
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
    ['projects.overview.progress.blocked', summary.blockedCount, 'blocked'],
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
                attentionCountTokens.has(token) && value > 0
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

/** Progress counts whose non-zero value asks for attention. */
const attentionCountTokens: ReadonlySet<string> = new Set(['overdue', 'high-priority', 'blocked'])

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
  /** Why the members could not be shown. */
  error?: ProjectOverviewMembersError
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
function MembersContent({ error, isLoading, members, onRetry, t }: MembersContentProps) {
  if (error === 'denied') return <StatusText>{t('projects.overview.error.membersDenied')}</StatusText>
  if (error) {
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

/** Lanes whose non-zero count asks for a person's attention. */
const attentionLanes: ReadonlySet<FactoryBoardLane> = new Set<FactoryBoardLane>(['decision', 'stalled', 'failed'])

/** Props for the Agent Run widget content. */
type AgentRunsContentProps = {
  /** Lane counts of the Project. */
  agentRuns?: ProjectOverviewAgentRuns
  /** Why the counts could not be shown. */
  error?: ProjectOverviewAgentRunsError
  /** Whether the board is loading. */
  isLoading: boolean
  /** Reads the board again after a failure. */
  onRetry?: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders how many of the Project's Work Items are in each Factory board lane.
 *
 * @param props - Lane counts and load state.
 * @returns Agent Run widget content.
 */
function AgentRunsContent({ agentRuns, error, isLoading, onRetry, t }: AgentRunsContentProps) {
  if (error === 'denied') return <StatusText>{t('projects.overview.error.agentRunsDenied')}</StatusText>
  if (error) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.agentRuns')}</StatusText>
  }
  if (isLoading || !agentRuns) return <StatusText>{t('projects.overview.loading')}</StatusText>

  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm min-[600px]:grid-cols-3">
        {FACTORY_BOARD_LANES.map((lane) => {
          const value = agentRuns.laneCounts[lane]
          return (
            <div className="min-w-0" data-testid={`project-overview-agent-lane-${lane}`} key={lane}>
              <dt className="text-xs font-medium text-[var(--workbench-muted)]">{t(`factoryBoard.lane.${lane}`)}</dt>
              <dd
                className={`text-lg font-semibold tabular-nums ${
                  attentionLanes.has(lane) && value > 0 ? 'text-fg-red-700' : 'text-[var(--workbench-text)]'
                }`}
              >
                {value}
              </dd>
            </div>
          )
        })}
      </dl>
      {agentRuns.isIncomplete ? (
        <StatusText>{t('projects.overview.agentRuns.incomplete')}</StatusText>
      ) : null}
    </div>
  )
}

/** Props for the Project log widget content. */
type RaidContentProps = {
  /** Why the log could not be shown. */
  error?: ProjectOverviewRaidError
  /** Whether the log is loading. */
  isLoading: boolean
  /** Locale used to format decision dates. */
  locale: Locale
  /** Reads the log again after a failure. */
  onRetry?: () => void
  /** Open counts and the listed entries. */
  raid?: ProjectOverviewRaid
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the open log counts, the most severe open risks and issues, and the recent decisions.
 *
 * @param props - Log summary and load state.
 * @returns Project log widget content.
 */
function RaidContent({ error, isLoading, locale, onRetry, raid, t }: RaidContentProps) {
  if (error === 'denied') return <StatusText>{t('projects.overview.error.raidDenied')}</StatusText>
  if (error) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.raid')}</StatusText>
  }
  if (isLoading || !raid) return <StatusText>{t('projects.overview.loading')}</StatusText>

  const counts: ReadonlyArray<readonly [MessageKey, number, string]> = [
    ['projects.overview.raid.openRisks', raid.openRiskCount, 'risks'],
    ['projects.overview.raid.openIssues', raid.openIssueCount, 'issues'],
    ['projects.overview.raid.pendingDecisions', raid.pendingDecisionCount, 'pending-decisions'],
    ['projects.overview.raid.overdueReviews', raid.overdueReviewCount, 'overdue-reviews'],
  ]

  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm min-[600px]:grid-cols-4">
        {counts.map(([labelKey, value, token]) => (
          <div className="min-w-0" data-testid={`project-overview-raid-count-${token}`} key={token}>
            <dt className="text-xs font-medium text-[var(--workbench-muted)]">{t(labelKey)}</dt>
            <dd
              className={`text-lg font-semibold tabular-nums ${
                token === 'overdue-reviews' && value > 0 ? 'text-fg-red-700' : 'text-[var(--workbench-text)]'
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2">
        <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{t('projects.overview.raid.attentionTitle')}</h4>
        {raid.attention.length === 0
          ? <StatusText>{t('projects.overview.raid.attentionEmpty')}</StatusText>
          : (
            <ul className="grid gap-2">
              {raid.attention.map((item) => (
                <RaidItemRow item={item} key={item.id} locale={locale} t={t} />
              ))}
            </ul>
          )}
        {raid.hiddenAttentionCount > 0 ? (
          <StatusText>
            {t('projects.overview.raid.attentionHidden').replace('{count}', String(raid.hiddenAttentionCount))}
          </StatusText>
        ) : null}
      </div>
      <div className="grid gap-2">
        <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{t('projects.overview.raid.decisionsTitle')}</h4>
        {raid.recentDecisions.length === 0
          ? <StatusText>{t('projects.overview.raid.decisionsEmpty')}</StatusText>
          : (
            <ul className="grid gap-2">
              {raid.recentDecisions.map((item) => (
                <RaidItemRow item={item} key={item.id} locale={locale} t={t} />
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

/** Props for one listed log entry. */
type RaidItemRowProps = {
  /** Entry shown by the row. */
  item: ProjectOverviewRaidItem
  /** Locale used to format the decision date. */
  locale: Locale
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders one open risk or issue, or one decided change request.
 *
 * @param props - Entry and labels.
 * @returns A list item.
 */
function RaidItemRow({ item, locale, t }: RaidItemRowProps) {
  return (
    <li
      className="grid gap-1 rounded-md border border-[var(--workbench-border)] px-3 py-2"
      data-testid={`project-overview-raid-${item.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-semibold text-[var(--workbench-text)]">{item.title}</span>
        {item.decidedAt === undefined ? (
          <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${severityClassNames[item.severity]}`}>
            {t(`projects.raidLog.severity.${item.severity}`)}
          </span>
        ) : null}
      </div>
      {item.decidedAt !== undefined && item.response ? (
        <p className="line-clamp-2 break-words text-xs font-medium text-[var(--workbench-text)]">{item.response}</p>
      ) : null}
      <p className="flex flex-wrap gap-x-3 text-xs font-medium text-[var(--workbench-muted)]">
        <span>{t(raidKindMessageKeys[item.kind])}</span>
        {item.decidedAt !== undefined ? (
          <span>{t('projects.overview.raid.decidedAt').replace('{date}', formatOverviewDate(item.decidedAt, locale))}</span>
        ) : item.reviewDueDate ? (
          <span className={item.isReviewOverdue ? 'font-semibold text-fg-red-700' : undefined}>
            {t('projects.raidLog.reviewDue').replace('{date}', item.reviewDueDate)}
          </span>
        ) : null}
      </p>
    </li>
  )
}

/**
 * Formats an ISO timestamp as a calendar date in the viewer's time zone.
 *
 * @param value - ISO timestamp.
 * @param locale - Locale used to format the date.
 * @returns The formatted date, or a dash for an invalid timestamp.
 */
function formatOverviewDate(value: string, locale: Locale) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

/** Props for the related Documents widget content. */
type DocumentsContentProps = {
  /** Listed Documents. */
  documents?: ProjectOverviewDocuments
  /** Why some Documents could not be shown. */
  error?: ProjectOverviewDocumentsError
  /** Whether the Documents are loading. */
  isLoading: boolean
  /** Reads the Documents again after a failure. */
  onRetry?: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the Documents that link to the Project or sit in its scope.
 *
 * A failure of one source is shown beside the Documents read from the other source.
 *
 * @param props - Document list and load state.
 * @returns Related Documents widget content.
 */
function DocumentsContent({ documents, error, isLoading, onRetry, t }: DocumentsContentProps) {
  const errorText = error === 'denied'
    ? <StatusText>{t('projects.overview.error.documentsDenied')}</StatusText>
    : error
      ? <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.documents')}</StatusText>
      : null
  if (!documents) {
    return errorText ?? <StatusText>{t('projects.overview.loading')}</StatusText>
  }

  return (
    <div className="grid gap-2">
      {errorText}
      {documents.items.length === 0 && !error && !isLoading
        ? <StatusText>{t('projects.overview.documents.empty')}</StatusText>
        : null}
      {documents.items.length > 0 ? (
        <ul className="grid gap-1.5">
          {documents.items.map((document) => (
            <li className="flex min-w-0 items-center justify-between gap-3 text-sm" key={document.id}>
              <Link
                className="min-w-0 truncate font-semibold text-[var(--workbench-text)] underline-offset-4 hover:underline focus-visible:underline"
                to={createDocumentPath(document.id)}
              >
                {document.title}
              </Link>
              <span className="flex-none text-xs font-semibold text-[var(--workbench-muted)]">
                {t(document.source === 'linked'
                  ? 'projects.overview.documents.linked'
                  : 'projects.overview.documents.inProject')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isLoading ? <StatusText>{t('projects.overview.loading')}</StatusText> : null}
      {documents.hiddenCount > 0 || documents.hasMore ? (
        <StatusText>{t('projects.overview.documents.more')}</StatusText>
      ) : null}
    </div>
  )
}

/** Props for the open action items widget content. */
type ActionItemsContentProps = {
  /** Open action items, absent while loading or after a failure. */
  actionItems?: ProjectOverviewActionItems
  /** Why the action items could not be shown. */
  error?: ProjectOverviewDocumentsError
  /** Whether the action items are loading. */
  isLoading: boolean
  /** Reads the action items again after a full or partial failure. */
  onRetry?: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the unchecked checklist items of the Project's pages with their
 * owner, deadline, and the page they come from.
 *
 * @param props - Action items and load state.
 * @returns Open action items widget content.
 */
function ActionItemsContent({ actionItems, error, isLoading, onRetry, t }: ActionItemsContentProps) {
  if (error === 'denied') {
    return <StatusText>{t('projects.overview.error.documentsDenied')}</StatusText>
  }
  if (error) {
    return <StatusText isError onRetry={onRetry} t={t}>{t('projects.overview.error.actionItems')}</StatusText>
  }
  if (!actionItems) {
    return isLoading ? <StatusText>{t('projects.overview.loading')}</StatusText> : null
  }
  return (
    <div className="grid gap-2">
      {actionItems.items.length === 0
        ? <StatusText>{t('projects.overview.actionItems.empty')}</StatusText>
        : (
            <ul className="grid gap-2">
              {actionItems.items.map((item) => (
                <li className="grid min-w-0 gap-0.5 text-sm" key={`${item.documentId}/${item.blockId}/${item.itemId}`}>
                  <span className="min-w-0 break-words font-semibold text-[var(--workbench-text)]">{item.text}</span>
                  <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium text-[var(--workbench-muted)]">
                    <span>
                      {item.ownerLabel
                        ? t('projects.overview.actionItems.owner').replace('{name}', item.ownerLabel)
                        : t('projects.overview.actionItems.noOwner')}
                    </span>
                    {item.dueDate ? (
                      <span className={item.overdue ? 'font-semibold text-[var(--workbench-danger)]' : undefined}>
                        {t(item.overdue ? 'projects.overview.actionItems.dueOverdue' : 'projects.overview.actionItems.due')
                          .replace('{date}', item.dueDate)}
                      </span>
                    ) : null}
                    <Link
                      className="min-w-0 truncate underline-offset-4 hover:underline focus-visible:underline"
                      to={createDocumentPath(item.documentId)}
                    >
                      {item.documentTitle}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
      {actionItems.hiddenCount > 0 ? (
        <StatusText>
          {t('projects.overview.actionItems.more').replace('{count}', String(actionItems.hiddenCount))}
        </StatusText>
      ) : null}
      {actionItems.failedDocumentCount > 0 ? (
        <StatusText isError onRetry={onRetry} t={t}>
          {t('projects.overview.actionItems.partialFailure').replace('{count}', String(actionItems.failedDocumentCount))}
        </StatusText>
      ) : null}
      {actionItems.hasUnscannedDocuments ? (
        <StatusText>{t('projects.overview.actionItems.unscanned')}</StatusText>
      ) : null}
    </div>
  )
}
