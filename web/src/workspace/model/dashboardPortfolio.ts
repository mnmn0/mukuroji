import type {
  PlanningHealth,
  PlanningUpdateState,
  PlanningUpdateTargetSummary,
} from '@mukuroji/contracts'
import type { WorkspacePortfolioProject } from '../../work-items/model/workspaceWorkItems'

/** Sort orders offered by the Workspace dashboard Project table. */
export const DASHBOARD_PORTFOLIO_SORTS = [
  'directory',
  'health',
  'update-oldest',
  'update-newest',
  'progress-ascending',
  'progress-descending',
] as const

/** Sort order applied to the Workspace dashboard Project table. */
export type DashboardPortfolioSort = (typeof DASHBOARD_PORTFOLIO_SORTS)[number]

/** Health filters offered by the Workspace dashboard Project table. */
export const DASHBOARD_PORTFOLIO_HEALTH_FILTERS = [
  'all',
  'off-track',
  'at-risk',
  'on-track',
  'unknown',
] as const

/** Reported-health filter applied to the Workspace dashboard Project table. */
export type DashboardPortfolioHealthFilter = (typeof DASHBOARD_PORTFOLIO_HEALTH_FILTERS)[number]

/**
 * Describes one Project row of the Workspace dashboard with its Planning update projection.
 */
export type DashboardPortfolioRow = {
  /** Directory-backed Project row with server-side Work Item progress. */
  project: WorkspacePortfolioProject
  /** Team-qualified Planning update projection, when one exists and could be loaded. */
  updateTarget?: PlanningUpdateTargetSummary
  /** Health reported by the latest Planning update, or unknown when none was reported. */
  health: PlanningHealth
  /** Update-delivery freshness of the Project. */
  updateState: PlanningUpdateState
  /** Creation instant of the latest Planning update, when one exists. */
  latestUpdateAt?: string
}

/** Rank of each reported health value, lowest first, used to put off-track Projects first. */
const healthSeverityRank: Record<PlanningHealth, number> = {
  'off-track': 0,
  'at-risk': 1,
  unknown: 2,
  'on-track': 3,
}

/**
 * Determines whether a value is one of the supported dashboard sort orders.
 *
 * @param value - Untrusted value, such as a select element value.
 * @returns True when the value is a supported sort order.
 */
export function isDashboardPortfolioSort(value: string): value is DashboardPortfolioSort {
  return DASHBOARD_PORTFOLIO_SORTS.some((sort) => sort === value)
}

/**
 * Determines whether a value is one of the supported dashboard health filters.
 *
 * @param value - Untrusted value, such as a select element value.
 * @returns True when the value is a supported health filter.
 */
export function isDashboardPortfolioHealthFilter(
  value: string,
): value is DashboardPortfolioHealthFilter {
  return DASHBOARD_PORTFOLIO_HEALTH_FILTERS.some((filter) => filter === value)
}

/**
 * Finds a Team-qualified Project update projection without cross-Team ID collisions.
 *
 * @param targets - Planning update projections visible to the user.
 * @param teamId - Team that owns the Project.
 * @param projectId - Team-local Project ID.
 * @returns The matching projection, or undefined when the Project has none.
 */
export function findProjectUpdateTarget(
  targets: readonly PlanningUpdateTargetSummary[],
  teamId: string,
  projectId: string,
) {
  return targets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === teamId &&
    candidate.target.projectId === projectId
  )
}

/**
 * Joins directory Project rows with their Planning update projections.
 *
 * Only Projects in the caller's directory become rows, so Planning projections for
 * Projects the user cannot see are never shown.
 *
 * @param projects - Directory-backed Project rows.
 * @param targets - Planning update projections visible to the user.
 * @param planningUpdatesUnavailable - Whether Planning projections failed to load.
 * @returns One dashboard row per directory Project, in directory order.
 */
export function createDashboardPortfolioRows(
  projects: readonly WorkspacePortfolioProject[],
  targets: readonly PlanningUpdateTargetSummary[],
  planningUpdatesUnavailable: boolean,
): DashboardPortfolioRow[] {
  return projects.map((project) => {
    const updateTarget = planningUpdatesUnavailable
      ? undefined
      : findProjectUpdateTarget(targets, project.teamId, project.projectId)

    return {
      project,
      ...(updateTarget ? { updateTarget } : {}),
      health: updateTarget?.latestUpdate?.health ?? 'unknown',
      updateState: updateTarget?.updateState ?? 'not-configured',
      ...(updateTarget?.latestUpdate ? { latestUpdateAt: updateTarget.latestUpdate.createdAt } : {}),
    }
  })
}

/**
 * Determines whether a Project needs reporting attention because its update is absent or late.
 *
 * @param row - Dashboard row to evaluate.
 * @returns True when the Project has no current update.
 */
export function needsDashboardReportingAttention(row: DashboardPortfolioRow) {
  return row.updateState === 'not-configured' || row.updateState === 'missing' ||
    row.updateState === 'stale' || row.updateState === 'overdue'
}

/**
 * Compares two optional ISO instants, placing missing values first.
 *
 * @param left - Left instant.
 * @param right - Right instant.
 * @returns A negative number when left is older or missing, positive when newer, otherwise zero.
 */
function compareOptionalInstants(left: string | undefined, right: string | undefined) {
  if (left === right) {
    return 0
  }
  if (left === undefined) {
    return -1
  }
  if (right === undefined) {
    return 1
  }

  return Date.parse(left) - Date.parse(right)
}

/**
 * Compares two rows by Project and Team name so ties stay deterministic.
 *
 * @param left - Left row.
 * @param right - Right row.
 * @returns Locale-aware name ordering.
 */
function compareRowNames(left: DashboardPortfolioRow, right: DashboardPortfolioRow) {
  return left.project.name.localeCompare(right.project.name) ||
    left.project.teamName.localeCompare(right.project.teamName)
}

/**
 * Filters and sorts dashboard Project rows without mutating the input.
 *
 * @param rows - Rows in directory order.
 * @param sort - Requested sort order; `directory` keeps the input order.
 * @param healthFilter - Reported health to keep, or `all`.
 * @returns A new array of matching rows in the requested order.
 */
export function arrangeDashboardPortfolioRows(
  rows: readonly DashboardPortfolioRow[],
  sort: DashboardPortfolioSort,
  healthFilter: DashboardPortfolioHealthFilter,
): DashboardPortfolioRow[] {
  const filtered = healthFilter === 'all'
    ? [...rows]
    : rows.filter((row) => row.health === healthFilter)

  switch (sort) {
    case 'directory':
      return filtered
    case 'health':
      return filtered.sort((left, right) =>
        healthSeverityRank[left.health] - healthSeverityRank[right.health] ||
        compareRowNames(left, right)
      )
    case 'update-oldest':
      return filtered.sort((left, right) =>
        compareOptionalInstants(left.latestUpdateAt, right.latestUpdateAt) ||
        compareRowNames(left, right)
      )
    case 'update-newest':
      return filtered.sort((left, right) =>
        compareOptionalInstants(right.latestUpdateAt, left.latestUpdateAt) ||
        compareRowNames(left, right)
      )
    case 'progress-ascending':
      return filtered.sort((left, right) =>
        left.project.progress - right.project.progress || compareRowNames(left, right)
      )
    case 'progress-descending':
      return filtered.sort((left, right) =>
        right.project.progress - left.project.progress || compareRowNames(left, right)
      )
  }
}
