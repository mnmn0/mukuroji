import { useCallback, useId, useRef, useState } from 'react'
import type {
  PlanningHealth,
  PlanningUpdateState,
  PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../api/directory'
import {
  PROJECT_DIRECTORY_UNASSIGNED_ID,
  isProjectDirectoryStatusFilter,
  type ProjectDirectoryAssignee,
  type ProjectDirectoryFilters,
  type ProjectDirectoryRow,
  type ProjectDirectoryStatus,
  type ProjectDirectoryStatusFilter,
} from '../model/projectDirectoryView'
import type { MessageKey } from '../../shared/i18n/i18n'
import { ProgressBar } from '../../shared/ui/WorkbenchPrimitives'
import { useModalFocus } from '../../shared/ui/useModalFocus'

/** Props for the searchable, filterable Project directory view. */
export type ProjectDirectoryViewProps = {
  /** All readable Teams used by the Team filter. */
  teams: readonly ProjectDirectoryTeam[]
  /** URL-backed filters currently applied to the directory. */
  filters: ProjectDirectoryFilters
  /** Assignee choices derived from all readable Projects. */
  assignees: readonly ProjectDirectoryAssignee[]
  /** Whether at least one Project has no represented assignee. */
  hasUnassignedProjects: boolean
  /** Project rows rendered on the current bounded page. */
  rows: readonly ProjectDirectoryRow[]
  /** Total readable Project count before filtering. */
  totalCount: number
  /** Project count after filtering and before pagination. */
  filteredCount: number
  /** Current one-based page number. */
  page: number
  /** Total available page count. */
  pageCount: number
  /** Whether the route locks the Team filter to one Team. */
  isTeamFilterLocked?: boolean
  /** Whether a quick-access replacement is currently being persisted. */
  isQuickAccessSaving?: boolean
  /** Whether Quick Access is loading or failed to load, making star controls unavailable. */
  isQuickAccessUnavailable?: boolean
  /** Translator used for all Project directory labels. */
  t: (key: MessageKey) => string
  /** Updates the search query in the route URL. */
  onSearchChange: (value: string) => void
  /** Updates the selected Team ID in the route URL. */
  onTeamChange: (teamId?: string) => void
  /** Updates the selected status in the route URL. */
  onStatusChange: (status: ProjectDirectoryStatusFilter) => void
  /** Updates the selected assignee in the route URL. */
  onAssigneeChange: (assigneeId?: string) => void
  /** Updates whether the route shows only starred Projects. */
  onQuickAccessOnlyChange: (quickAccessOnly: boolean) => void
  /** Removes every optional Project directory filter from the route URL. */
  onClearFilters: () => void
  /** Navigates to a bounded Project directory page. */
  onPageChange: (page: number) => void
  /** Opens a Project in its owning Team context. */
  onOpenProject: (project: ProjectDirectoryRow) => void
  /** Adds or removes a Project from quick access. */
  onToggleQuickAccess: (project: ProjectDirectoryRow) => void | Promise<void>
  /** Archives a Project after explicit confirmation when authorized. */
  onArchiveProject?: (project: ProjectDirectoryRow) => Promise<void>
  /** Project update projections keyed by Team and Project identity. */
  planningUpdateTargets?: readonly PlanningUpdateTargetSummary[]
  /** Opens the selected Project's Planning update detail. */
  onOpenPlanningUpdate?: (project: ProjectDirectoryRow) => void
}

const statusFilters: readonly ProjectDirectoryStatusFilter[] = [
  'all',
  'active',
  'attention',
  'completed',
  'not-started',
]

const projectToneClassNames: Record<
  NonNullable<ProjectDirectoryRow['tone']>,
  string
> = {
  blue: 'border-blue-200 bg-blue-100 text-blue-700',
  green: 'border-emerald-200 bg-emerald-100 text-emerald-700',
  purple: 'border-violet-200 bg-violet-100 text-violet-700',
  yellow: 'border-amber-200 bg-amber-100 text-amber-700',
}

const statusClassNames: Record<ProjectDirectoryStatus, string> = {
  active: 'border-sky-200 bg-sky-50 text-sky-700',
  attention: 'border-amber-200 bg-amber-50 text-amber-800',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'not-started': 'border-slate-200 bg-slate-50 text-slate-600',
}

const statusMessageKeys: Record<ProjectDirectoryStatus, MessageKey> = {
  active: 'projects.directory.status.active',
  attention: 'projects.directory.status.attention',
  completed: 'projects.directory.status.completed',
  'not-started': 'projects.directory.status.notStarted',
}

/** Badge tokens for Project update freshness, kept separate from reported health. */
const planningUpdateStateClassNames: Record<PlanningUpdateState, string> = {
  'not-configured': 'border-slate-200 bg-slate-50 text-slate-600',
  missing: 'border-slate-300 bg-white text-slate-700',
  current: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  stale: 'border-amber-200 bg-amber-50 text-amber-800',
  overdue: 'border-red-200 bg-red-50 text-red-700',
}

/** Badge tokens for latest reported Project health. */
const planningUpdateHealthClassNames: Record<PlanningHealth, string> = {
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
  'on-track': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'at-risk': 'border-amber-200 bg-amber-50 text-amber-800',
  'off-track': 'border-red-200 bg-red-50 text-red-700',
}

/** Finds one Team-qualified Project update target. */
function findProjectPlanningUpdate(
  targets: readonly PlanningUpdateTargetSummary[],
  project: ProjectDirectoryRow,
) {
  return targets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === project.teamId &&
    candidate.target.projectId === project.projectId
  )
}

/**
 * Renders scalable Project discovery with URL-owned filters and bounded pagination.
 *
 * @param props - Project rows, facets, pagination, and route actions.
 * @returns The responsive Project filter surface and result collection.
 */
export function ProjectDirectoryView({
  assignees,
  filteredCount,
  filters,
  hasUnassignedProjects,
  isQuickAccessSaving = false,
  isQuickAccessUnavailable = false,
  isTeamFilterLocked = false,
  page,
  pageCount,
  rows,
  t,
  teams,
  totalCount,
  onArchiveProject,
  onOpenPlanningUpdate,
  onAssigneeChange,
  onClearFilters,
  onOpenProject,
  onPageChange,
  onQuickAccessOnlyChange,
  onSearchChange,
  onStatusChange,
  onTeamChange,
  onToggleQuickAccess,
  planningUpdateTargets = [],
}: ProjectDirectoryViewProps) {
  const [archiveTarget, setArchiveTarget] = useState<ProjectDirectoryRow>()
  const [isArchiving, setIsArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const resultsRef = useRef<HTMLDivElement>(null)
  const hasActiveFilters = Boolean(
    filters.query ||
    (!isTeamFilterLocked && filters.teamId) ||
    filters.status !== 'all' ||
    filters.assigneeId ||
    filters.quickAccessOnly,
  )

  /** Closes the archive confirmation without changing its target. */
  const closeArchiveDialog = useCallback(() => {
    if (isArchiving) {
      return
    }
    setArchiveTarget(undefined)
    setArchiveError(false)
  }, [isArchiving])

  /** Archives the selected Project and closes the confirmation on success. */
  const confirmArchive = async () => {
    if (!archiveTarget || !onArchiveProject) {
      return
    }
    setIsArchiving(true)
    setArchiveError(false)
    try {
      await onArchiveProject(archiveTarget)
      setArchiveTarget(undefined)
      window.requestAnimationFrame(() => resultsRef.current?.focus())
    } catch {
      setArchiveError(true)
    } finally {
      setIsArchiving(false)
    }
  }

  const resultCountLabel = formatProjectDirectoryMessage(
    t('projects.directory.resultCount'),
    { filtered: filteredCount, total: totalCount },
  )
  const paginationLabel = formatProjectDirectoryMessage(
    t('projects.directory.pagination.label'),
    { page, pages: pageCount },
  )

  return (
    <section aria-label={t('projects.directory.title')} className="grid gap-5">
      <div className="workbench-panel p-4 sm:p-5">
        <div className="grid grid-cols-[minmax(220px,2fr)_repeat(3,minmax(150px,1fr))] gap-3 max-[1100px]:grid-cols-2 max-[680px]:grid-cols-1">
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('projects.directory.searchLabel')}
            <span className="relative block">
              <SearchIcon />
              <input
                autoComplete="off"
                className="workbench-input h-11 w-full pl-10 pr-3"
                placeholder={t('projects.directory.searchPlaceholder')}
                type="search"
                value={filters.query}
                onChange={(event) => onSearchChange(event.currentTarget.value)}
              />
            </span>
          </label>

          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('projects.directory.teamFilter')}
            <select
              className="workbench-input h-11 w-full px-3 disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
              disabled={isTeamFilterLocked}
              value={filters.teamId ?? ''}
              onChange={(event) => onTeamChange(event.currentTarget.value || undefined)}
            >
              {!isTeamFilterLocked ? (
                <option value="">{t('projects.directory.filterAll')}</option>
              ) : null}
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('projects.directory.statusFilter')}
            <select
              className="workbench-input h-11 w-full px-3"
              value={filters.status}
              onChange={(event) => {
                if (isProjectDirectoryStatusFilter(event.currentTarget.value)) {
                  onStatusChange(event.currentTarget.value)
                }
              }}
            >
              {statusFilters.map((status) => (
                <option key={status} value={status}>
                  {status === 'all'
                    ? t('projects.directory.filterAll')
                    : t(statusMessageKeys[status])}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('projects.directory.assigneeFilter')}
            <select
              className="workbench-input h-11 w-full px-3"
              value={filters.assigneeId ?? ''}
              onChange={(event) => onAssigneeChange(event.currentTarget.value || undefined)}
            >
              <option value="">{t('projects.directory.filterAll')}</option>
              {hasUnassignedProjects ? (
                <option value={PROJECT_DIRECTORY_UNASSIGNED_ID}>
                  {t('projects.directory.assignee.unassigned')}
                </option>
              ) : null}
              {assignees.map((assignee) => (
                <option key={assignee.id} value={assignee.id}>{assignee.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] pt-4">
          <button
            aria-pressed={filters.quickAccessOnly}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)] focus:ring-offset-2 ${
              filters.quickAccessOnly
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            disabled={isQuickAccessUnavailable}
            title={isQuickAccessUnavailable
              ? t('projects.directory.quickAccess.unavailable')
              : undefined}
            type="button"
            onClick={() => onQuickAccessOnlyChange(!filters.quickAccessOnly)}
          >
            <StarIcon selected={filters.quickAccessOnly} />
            {t('projects.directory.quickAccessOnly')}
          </button>

          <div className="flex min-w-0 items-center gap-3">
            <p aria-live="polite" className="text-sm font-semibold text-[var(--workbench-muted)]">
              {resultCountLabel}
            </p>
            {hasActiveFilters ? (
              <button
                className="min-h-10 rounded-lg px-3 text-sm font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)]"
                type="button"
                onClick={onClearFilters}
              >
                {t('projects.directory.clearFilters')}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div
        aria-label={t('projects.directory.title')}
        className="workbench-table overflow-hidden focus:outline-none"
        data-testid="project-directory-results"
        ref={resultsRef}
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className="grid grid-cols-[44px_minmax(190px,1.5fr)_minmax(130px,0.8fr)_130px_minmax(130px,0.9fr)_140px_120px_48px] items-center gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-xs font-semibold text-[var(--workbench-muted)] max-[1100px]:grid-cols-[44px_minmax(190px,1.5fr)_minmax(130px,0.8fr)_130px_140px_48px] max-[1100px]:[&>*:nth-child(5)]:hidden max-[1100px]:[&>*:nth-child(7)]:hidden max-[760px]:hidden"
        >
          <span />
          <span>{t('projects.directory.column.project')}</span>
          <span>{t('projects.directory.column.team')}</span>
          <span>{t('projects.directory.column.status')}</span>
          <span>{t('projects.directory.column.assignee')}</span>
          <span>{t('projects.directory.column.progress')}</span>
          <span>{t('projects.directory.column.workItems')}</span>
          <span className="sr-only">{t('projects.directory.column.actions')}</span>
        </div>

        {rows.length > 0 ? (
          <div aria-label={t('projects.directory.title')} role="list">
            {rows.map((row) => (
              <ProjectDirectoryListRow
                isQuickAccessSaving={isQuickAccessSaving}
                isQuickAccessUnavailable={isQuickAccessUnavailable}
                key={row.key}
                project={row}
                planningUpdate={findProjectPlanningUpdate(planningUpdateTargets, row)}
                t={t}
                onArchiveProject={onArchiveProject
                  ? () => {
                      setArchiveError(false)
                      setArchiveTarget(row)
                    }
                  : undefined}
                onOpenProject={() => onOpenProject(row)}
                onOpenPlanningUpdate={onOpenPlanningUpdate
                  ? () => onOpenPlanningUpdate(row)
                  : undefined}
                onToggleQuickAccess={() => void onToggleQuickAccess(row)}
              />
            ))}
          </div>
        ) : (
          <ProjectDirectoryEmptyState hasActiveFilters={hasActiveFilters} t={t} />
        )}

        {filteredCount > 0 && pageCount > 1 ? (
          <nav
            aria-label={paginationLabel}
            className="flex items-center justify-between gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3"
          >
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={page <= 1}
              type="button"
              onClick={() => onPageChange(page - 1)}
            >
              {t('projects.directory.pagination.previous')}
            </button>
            <span className="text-sm font-semibold text-[var(--workbench-muted)]">
              {paginationLabel}
            </span>
            <button
              className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={page >= pageCount}
              type="button"
              onClick={() => onPageChange(page + 1)}
            >
              {t('projects.directory.pagination.next')}
            </button>
          </nav>
        ) : null}
      </div>

      {archiveTarget && onArchiveProject ? (
        <ProjectArchiveDialog
          error={archiveError}
          isBusy={isArchiving}
          project={archiveTarget}
          t={t}
          onClose={closeArchiveDialog}
          onConfirm={() => void confirmArchive()}
        />
      ) : null}
    </section>
  )
}

/** Props for one responsive Project directory row. */
type ProjectDirectoryListRowProps = {
  /** Project data rendered in the row. */
  project: ProjectDirectoryRow
  /** Latest/cadence projection for this Team-qualified Project. */
  planningUpdate?: PlanningUpdateTargetSummary
  /** Whether a quick-access request is currently being persisted. */
  isQuickAccessSaving: boolean
  /** Whether Quick Access is not ready and the star cannot be changed. */
  isQuickAccessUnavailable: boolean
  /** Translator used for row labels. */
  t: (key: MessageKey) => string
  /** Opens the Project detail route. */
  onOpenProject: () => void
  /** Opens the Project update detail without changing the task-list action. */
  onOpenPlanningUpdate?: () => void
  /** Adds or removes the Project from quick access. */
  onToggleQuickAccess: () => void
  /** Opens the archive confirmation when available. */
  onArchiveProject?: () => void
}

/**
 * Renders one Project row without duplicating its content for mobile layouts.
 *
 * @param props - Project data and available row actions.
 * @returns A responsive list row with direct open, star, and archive controls.
 */
function ProjectDirectoryListRow({
  isQuickAccessSaving,
  isQuickAccessUnavailable,
  project,
  planningUpdate,
  t,
  onArchiveProject,
  onOpenProject,
  onOpenPlanningUpdate,
  onToggleQuickAccess,
}: ProjectDirectoryListRowProps) {
  const tone = project.tone ?? 'blue'
  const statusLabel = t(statusMessageKeys[project.status])
  const starLabel = formatProjectDirectoryMessage(
    t(project.isQuickAccess
      ? 'projects.directory.quickAccess.remove'
      : 'projects.directory.quickAccess.add'),
    { name: project.projectName },
  )
  const updateState = planningUpdate?.updateState ?? 'not-configured'
  const updateHealth = planningUpdate?.latestUpdate?.health ?? 'unknown'

  return (
    <div
      className="grid grid-cols-[44px_minmax(190px,1.5fr)_minmax(130px,0.8fr)_130px_minmax(130px,0.9fr)_140px_120px_48px] items-center gap-3 border-b border-[var(--workbench-border)] px-4 py-3 transition-colors last:border-b-0 hover:bg-[var(--workbench-surface-muted)] max-[1100px]:grid-cols-[44px_minmax(190px,1.5fr)_minmax(130px,0.8fr)_130px_140px_48px] max-[760px]:grid-cols-[44px_minmax(0,1fr)_44px] max-[760px]:items-start"
      role="listitem"
    >
      <button
        aria-label={starLabel}
        aria-pressed={project.isQuickAccess}
        className={`grid h-10 w-10 place-items-center rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)] focus:ring-offset-2 ${
          project.isQuickAccess
            ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
            : 'text-slate-400 hover:bg-slate-100 hover:text-amber-600'
        }`}
        disabled={isQuickAccessSaving || isQuickAccessUnavailable}
        title={isQuickAccessUnavailable
          ? t('projects.directory.quickAccess.unavailable')
          : isQuickAccessSaving
            ? t('projects.directory.quickAccess.saving')
            : starLabel}
        type="button"
        onClick={onToggleQuickAccess}
      >
        <StarIcon selected={project.isQuickAccess} />
      </button>

      <div className="min-w-0">
        <button
          aria-label={formatProjectDirectoryMessage(
            t('projects.directory.open'),
            { name: project.projectName },
          )}
          className="group flex min-h-10 max-w-full items-center gap-3 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)] focus:ring-offset-2"
          type="button"
          onClick={onOpenProject}
        >
          <span
            aria-hidden="true"
            className={`grid h-8 w-8 flex-none place-items-center rounded-lg border text-xs font-bold ${projectToneClassNames[tone]}`}
          >
            {project.projectName.trim().charAt(0).toLocaleUpperCase() || 'P'}
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--workbench-text)] underline-offset-4 group-hover:underline">
            {project.projectName}
          </span>
        </button>
        <p className="mt-1 hidden truncate text-xs font-medium text-[var(--workbench-muted)] max-[760px]:block">
          {project.teamName} · {statusLabel}
        </p>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${planningUpdateHealthClassNames[updateHealth]}`}>
            {t(`planning.health.${updateHealth}`)}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${planningUpdateStateClassNames[updateState]}`}>
            {t(`planning.updateState.${updateState}`)}
          </span>
          <div
            className="grid min-w-0 basis-full gap-0.5"
            data-testid={`project-update-summary-${project.teamId}-${project.projectId}`}
          >
            {onOpenPlanningUpdate ? (
              <button
                className="min-h-8 min-w-0 truncate rounded-md px-1 text-left text-xs font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)]"
                type="button"
                onClick={onOpenPlanningUpdate}
              >
                {planningUpdate?.latestUpdate?.summary ?? t('planning.updateState.neverUpdated')}
                {planningUpdate?.cadence?.nextDueAt
                  ? ` · ${formatProjectDirectoryMessage(t('planning.updateState.dueMeta'), {
                      date: planningUpdate.cadence.nextDueAt.slice(0, 10),
                    })}`
                  : ''}
              </button>
            ) : (
              <span className="min-w-0 truncate px-1 text-xs font-semibold text-[var(--workbench-muted)]">
                {planningUpdate?.latestUpdate?.summary ?? t('planning.updateState.neverUpdated')}
                {planningUpdate?.cadence?.nextDueAt
                  ? ` · ${formatProjectDirectoryMessage(t('planning.updateState.dueMeta'), {
                      date: planningUpdate.cadence.nextDueAt.slice(0, 10),
                    })}`
                  : ''}
              </span>
            )}
            {planningUpdate?.latestUpdate ? (
              <span className="min-w-0 truncate px-1 text-[11px] font-medium text-[var(--workbench-muted)]">
                {formatProjectDirectoryMessage(t('planning.updateState.updatedMeta'), {
                  author: planningUpdate.latestUpdate.authorMemberKey,
                  date: planningUpdate.latestUpdate.createdAt.slice(0, 10),
                })}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <p className="truncate text-sm font-medium text-[var(--workbench-muted)] max-[760px]:hidden">
        {project.teamName}
      </p>

      <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassNames[project.status]} max-[760px]:hidden`}>
        {statusLabel}
      </span>

      <ProjectAssigneeSummary project={project} t={t} />

      <div className="grid min-w-0 grid-cols-[minmax(72px,1fr)_40px] items-center gap-2 max-[760px]:col-span-2 max-[760px]:col-start-2 max-[760px]:mt-1">
        <ProgressBar
          label={`${project.projectName} ${t('projects.directory.column.progress')}`}
          value={project.progress}
        />
        <span className="text-right text-xs font-semibold tabular-nums text-[var(--workbench-muted)]">
          {project.progress}%
        </span>
      </div>

      <p className="text-xs font-semibold tabular-nums text-[var(--workbench-muted)] max-[1100px]:hidden">
        {formatProjectDirectoryMessage(
          t('projects.directory.workItems'),
          {
            open: project.openWorkItemCount,
            total: project.workItemCount,
          },
        )}
      </p>

      {onArchiveProject ? (
        <button
          aria-label={formatProjectDirectoryMessage(
            t('projects.directory.archive.label'),
            { name: project.projectName },
          )}
          className="grid h-10 w-10 place-items-center rounded-lg text-[var(--workbench-muted)] transition-colors hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)] focus:ring-offset-2 max-[760px]:row-start-1 max-[760px]:col-start-3"
          type="button"
          onClick={onArchiveProject}
        >
          <ArchiveIcon />
        </button>
      ) : (
        <span aria-hidden="true" className="max-[760px]:hidden" />
      )}
    </div>
  )
}

/** Props for a compact Project assignee summary. */
type ProjectAssigneeSummaryProps = {
  /** Project whose first represented assignee is displayed. */
  project: ProjectDirectoryRow
  /** Translator used for fallback and overflow labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders a compact assignee avatar and overflow count.
 *
 * @param props - Project row and translator.
 * @returns Assignee summary hidden on narrow layouts.
 */
function ProjectAssigneeSummary({ project, t }: ProjectAssigneeSummaryProps) {
  const firstAssignee = project.assignees[0]

  return (
    <div className="flex min-w-0 items-center gap-2 max-[1100px]:hidden">
      {firstAssignee ? (
        <>
          <span
            aria-hidden="true"
            className="grid h-7 w-7 flex-none place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-[10px] font-bold text-[var(--workbench-primary)]"
          >
            {createPersonInitials(firstAssignee.label)}
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-[var(--workbench-muted)]">
            {firstAssignee.label}
          </span>
          {project.assignees.length > 1 ? (
            <span className="flex-none text-xs font-semibold text-[var(--workbench-muted)]">
              {formatProjectDirectoryMessage(
                t('projects.directory.assignee.more'),
                { count: project.assignees.length - 1 },
              )}
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-sm font-medium text-[var(--workbench-muted)]">
          {t('projects.directory.assignee.unassigned')}
        </span>
      )}
    </div>
  )
}

/** Props for the Project directory's empty-state message. */
type ProjectDirectoryEmptyStateProps = {
  /** Whether filters, rather than an empty Workspace, produced no rows. */
  hasActiveFilters: boolean
  /** Translator used for empty-state copy. */
  t: (key: MessageKey) => string
}

/**
 * Renders distinct empty states for an empty Workspace and zero filter matches.
 *
 * @param props - Empty-state kind and translator.
 * @returns An informative empty Project directory panel.
 */
function ProjectDirectoryEmptyState({
  hasActiveFilters,
  t,
}: ProjectDirectoryEmptyStateProps) {
  return (
    <div className="grid min-h-64 place-items-center px-6 py-12 text-center">
      <div className="max-w-md">
        <span
          aria-hidden="true"
          className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]"
        >
          <FolderIcon />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-[var(--workbench-text)]">
          {t(hasActiveFilters
            ? 'projects.directory.emptyFiltered.title'
            : 'projects.directory.empty.title')}
        </h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t(hasActiveFilters
            ? 'projects.directory.emptyFiltered.description'
            : 'projects.directory.empty.description')}
        </p>
      </div>
    </div>
  )
}

/** Props for the Project archive confirmation dialog. */
type ProjectArchiveDialogProps = {
  /** Whether the previous archive request failed. */
  error: boolean
  /** Whether the archive request is currently running. */
  isBusy: boolean
  /** Project that will be archived after confirmation. */
  project: ProjectDirectoryRow
  /** Translator used for dialog labels. */
  t: (key: MessageKey) => string
  /** Closes the dialog when no request is running. */
  onClose: () => void
  /** Confirms the archive request. */
  onConfirm: () => void
}

/**
 * Renders an accessible destructive confirmation with trapped focus.
 *
 * @param props - Archive target, state, translator, and actions.
 * @returns A modal confirmation dialog.
 */
function ProjectArchiveDialog({
  error,
  isBusy,
  project,
  t,
  onClose,
  onConfirm,
}: ProjectArchiveDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(onClose)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  const descriptionId = `${dialogId}-description`

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!isBusy) {
          onClose()
        }
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel w-full max-w-[440px] overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2 className="text-xl font-semibold text-[var(--workbench-text)]" id={titleId}>
            {t('projects.directory.archive.title')}
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]" id={descriptionId}>
            {formatProjectDirectoryMessage(
              t('projects.directory.archive.description'),
              { name: project.projectName },
            )}
          </p>
          {error ? (
            <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
              {t('projects.directory.archive.error')}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-modal-initial-focus
              disabled={isBusy}
              type="button"
              onClick={onClose}
            >
              {t('projects.directory.archive.cancel')}
            </button>
            <button
              className="min-h-10 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isBusy}
              type="button"
              onClick={onConfirm}
            >
              {isBusy
                ? t('projects.directory.archive.saving')
                : t('projects.directory.archive.confirm')}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Formats a Project directory message without widening translation keys.
 *
 * @param template - Translated string containing named placeholders.
 * @param replacements - Placeholder values keyed without braces.
 * @returns Message with every supplied placeholder replaced.
 */
function formatProjectDirectoryMessage(
  template: string,
  replacements: Readonly<Record<string, string | number>>,
) {
  return Object.entries(replacements).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

/**
 * Creates at most two readable initials for an assignee avatar.
 *
 * @param label - Assignee display label.
 * @returns Uppercase initials, or a neutral fallback.
 */
function createPersonInitials(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  const initials = parts.length > 1
    ? `${parts[0]?.charAt(0) ?? ''}${parts.at(-1)?.charAt(0) ?? ''}`
    : label.trim().slice(0, 2)
  return initials.toLocaleUpperCase() || '—'
}

/**
 * Renders the search icon embedded in the Project query field.
 *
 * @returns A decorative magnifying glass icon.
 */
function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workbench-muted)]"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  )
}

/** Props for the selectable star icon. */
type StarIconProps = {
  /** Whether the star is filled. */
  selected: boolean
}

/**
 * Renders a filled or outlined star using the surrounding text color.
 *
 * @param props - Selected state controlling the fill.
 * @returns A decorative star icon.
 */
function StarIcon({ selected }: StarIconProps) {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill={selected ? 'currentColor' : 'none'} viewBox="0 0 24 24">
      <path
        d="m12 3.6 2.55 5.16 5.7.83-4.12 4.02.97 5.68L12 16.6l-5.1 2.69.97-5.68-4.12-4.02 5.7-.83L12 3.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * Renders the archive icon used by authorized Project rows.
 *
 * @returns A decorative archive box icon.
 */
function ArchiveIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="M5 8.5h14v10H5z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M4 5h16v3.5H4zM9.5 12h5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

/**
 * Renders the Project folder used by directory empty states.
 *
 * @returns A decorative folder icon.
 */
function FolderIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path d="M3.5 7.5h6l2 2H20.5v9h-17v-11Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M3.5 9.5V5.7h6.2l1.8 1.8" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}
