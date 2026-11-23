import {
  deriveWorkItemBaselineEndDelayDays,
  deriveWorkItemRemainingEffortMinutes,
  PORTFOLIO_DASHBOARD_SCHEMA_VERSION,
  PORTFOLIO_TEAM_PROJECT_LIMIT,
  readWorkItemPlannedEndDate,
  summarizeProjectRaidLog,
  type CanonicalWorkItem,
  type PortfolioProjectBudget,
  type PortfolioProjectMetrics,
  type PortfolioProjectMilestone,
  type ProjectRaidEntry,
  type ProjectScheduleBaseline,
  type ProjectScheduleBaselineEntry,
  type TeamPortfolioSnapshot,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** Work Item fields the portfolio reads. */
export type PortfolioWorkItem = Pick<
  CanonicalWorkItem,
  'id' | 'key' | 'title' | 'schedule' | 'statusCategory' | 'actualEndDate' | 'archivedAt' | 'remainingEffortMinutes'
> & {
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
}

/** Budget and cost of one Project as the time tracking service totals them. */
export type PortfolioBudgetSource = {
  /** Stored budget fields the portfolio shows. */
  budget: {
    /** Budget amount in minor currency units. */
    amountMinor: number
    /** ISO 4217 currency code. */
    currency: string
    /** Inclusive local period start. */
    periodFrom?: string
    /** Inclusive local period end. */
    periodTo?: string
  }
  /** Billable cost in the budget currency, in minor units. */
  actualCostMinor: number
  /** Whether billable cost was recorded in another currency. */
  hasOtherCurrencyCost: boolean
}

/** Inputs of {@link buildTeamPortfolioProjects}, after the route authorized the reader. */
export type TeamPortfolioInput<TWorkItem extends PortfolioWorkItem> = {
  /** Projects of the Team the reader may read, in directory order. */
  projectIds: readonly string[]
  /** The Team's Work Items the reader may read. */
  workItems: Iterable<TWorkItem>
  /** Active baseline of each readable Project; a Project without one maps to `null`. */
  baselines: ReadonlyMap<string, ProjectScheduleBaseline | null>
  /** Log entries of each readable Project. */
  raidEntries: ReadonlyMap<string, readonly ProjectRaidEntry[]>
  /** Budget and cost of each Project whose costs the reader may see and that has a budget. */
  budgets: ReadonlyMap<string, PortfolioBudgetSource>
  /**
   * Tells whether the reader may see a Project's budget and cost.
   *
   * @param projectId - Project ID.
   * @returns Whether costs are visible.
   */
  canSeeCost: (projectId: string) => boolean
  /** Today as `YYYY-MM-DD`, used for log review dates. */
  today: string
  /**
   * Returns today's date in the Work Item's schedule calendar, so "overdue" follows the calendar
   * its dates are written in.
   *
   * @param workItem - Work Item.
   * @returns Local `YYYY-MM-DD` date.
   */
  localToday: (workItem: TWorkItem) => string
}

/** Per-Project totals while Work Items are added. */
type ProjectAccumulator = {
  /** Baseline entries keyed by Work Item ID, when the Project has a baseline. */
  baselineEntries?: ReadonlyMap<string, ProjectScheduleBaselineEntry>
  /** Work Item counts. */
  workItems: PortfolioProjectMetrics['workItems']
  /** Effort totals. */
  effort: PortfolioProjectMetrics['effort']
  /** Open Work Items behind their baseline. */
  delayedOpenCount: number
  /** Largest open delay. */
  maxDelayDays: number
  /** Earliest open Milestone. */
  nextMilestone?: PortfolioProjectMilestone
}

/** What decides whether a reader may save a Team's monthly portfolio snapshot. */
export type PortfolioSnapshotCaptureAccess = {
  /** Whether the reader is a system administrator. */
  isSystemAdmin: boolean
  /** Whether the reader has manager access to the Team at all. */
  isTeamManager: boolean
  /** Whether the manager access is granted on the Team itself rather than per Project. */
  directTeamGrant: boolean
  /** Every Project of the Team. */
  projectIds: readonly string[]
  /** Whether the reader may read a Project. */
  canReadProject: (projectId: string) => boolean
  /** Whether the reader may see a Project's budget and cost. */
  canSeeCost: (projectId: string) => boolean
}

/**
 * Decides whether a reader may save a Team's monthly snapshot. A save replaces the month for
 * every later reader, so it must hold every Project with its cost: even a Team-wide grant saves
 * only when it can read and see the cost of each Project. An empty Team needs the Team-wide grant.
 *
 * @param access - Reader access.
 * @returns Whether the reader may save the snapshot.
 */
export function canCaptureTeamPortfolioSnapshot(access: PortfolioSnapshotCaptureAccess): boolean {
  if (access.isSystemAdmin) return true
  if (!access.isTeamManager) return false
  if (access.projectIds.length === 0) return access.directTeamGrant
  return access.projectIds.every((projectId) => access.canReadProject(projectId) && access.canSeeCost(projectId))
}

/**
 * Rejects a Team with more Projects than one portfolio response holds.
 *
 * @param projectCount - Number of Projects in the Team.
 * @throws ProjectDataError 413 when the Team has too many Projects.
 */
export function assertPortfolioProjectLimit(projectCount: number): void {
  if (projectCount > PORTFOLIO_TEAM_PROJECT_LIMIT) {
    throw new ProjectDataError(
      413,
      'PortfolioTooLarge',
      `A Team portfolio can list at most ${PORTFOLIO_TEAM_PROJECT_LIMIT} Projects.`,
    )
  }
}

/**
 * Computes the portfolio metrics of each readable Project of a Team: Work Item and effort
 * progress, delay against the active baseline, the next open Milestone, open log entries, and
 * budget consumption where the reader may see costs.
 *
 * Archived and canceled Work Items are not counted, and Work Items of Projects the reader cannot
 * read never reach a row.
 *
 * @param input - Readable Projects and their sources.
 * @returns One row per readable Project, in the given order.
 */
export function buildTeamPortfolioProjects<TWorkItem extends PortfolioWorkItem>(
  input: TeamPortfolioInput<TWorkItem>,
): PortfolioProjectMetrics[] {
  const accumulators = new Map<string, ProjectAccumulator>()
  for (const projectId of input.projectIds) {
    const baseline = input.baselines.get(projectId) ?? null
    accumulators.set(projectId, {
      ...(baseline === null
        ? {}
        : { baselineEntries: new Map(baseline.entries.map((entry) => [entry.workItemId, entry] as const)) }),
      workItems: { total: 0, open: 0, completed: 0, overdueOpen: 0 },
      effort: { estimatedCount: 0, plannedMinutes: 0, remainingMinutes: 0 },
      delayedOpenCount: 0,
      maxDelayDays: 0,
    })
  }

  for (const workItem of input.workItems) {
    if (workItem.archivedAt !== undefined || workItem.statusCategory === 'canceled') continue
    const projectId = workItem.assignedProjectId
    const project = projectId === undefined ? undefined : accumulators.get(projectId)
    if (!project) continue
    const open = workItem.statusCategory !== 'completed'
    project.workItems.total += 1
    if (open) project.workItems.open += 1
    else project.workItems.completed += 1

    const plannedEndDate = readWorkItemPlannedEndDate(workItem.schedule)
    if (open && plannedEndDate !== undefined && plannedEndDate < input.localToday(workItem)) {
      project.workItems.overdueOpen += 1
    }

    const planned = workItem.schedule.plannedEffortMinutes
    if (planned !== undefined) {
      project.effort.estimatedCount += 1
      project.effort.plannedMinutes += planned
      project.effort.remainingMinutes += Math.min(planned, deriveWorkItemRemainingEffortMinutes(workItem) ?? planned)
    }

    const baselineEntry = project.baselineEntries?.get(workItem.id)
    const delayDays = open && baselineEntry ? deriveWorkItemBaselineEndDelayDays(baselineEntry, workItem) : undefined
    if (delayDays !== undefined && delayDays > 0) {
      project.delayedOpenCount += 1
      project.maxDelayDays = Math.max(project.maxDelayDays, delayDays)
    }

    if (open && workItem.schedule.mode === 'milestone' && plannedEndDate !== undefined) {
      const current = project.nextMilestone
      if (
        !current ||
        plannedEndDate < current.dueDate ||
        (plannedEndDate === current.dueDate && workItem.id < current.workItemId)
      ) {
        project.nextMilestone = {
          workItemId: workItem.id,
          ...(workItem.key === undefined ? {} : { key: workItem.key }),
          title: workItem.title,
          dueDate: plannedEndDate,
        }
      }
    }
  }

  return input.projectIds.map((projectId) => {
    const project = accumulators.get(projectId)
    if (!project) throw new Error(`Project "${projectId}" has no accumulator.`)
    const raid = summarizeProjectRaidLog(input.raidEntries.get(projectId) ?? [], input.today)
    const costHidden = !input.canSeeCost(projectId)
    const budgetSource = costHidden ? undefined : input.budgets.get(projectId)
    return {
      projectId,
      workItems: project.workItems,
      effort: project.effort,
      schedule: {
        hasBaseline: project.baselineEntries !== undefined,
        delayedOpenCount: project.delayedOpenCount,
        ...(project.maxDelayDays > 0 ? { maxDelayDays: project.maxDelayDays } : {}),
      },
      ...(project.nextMilestone ? { nextMilestone: project.nextMilestone } : {}),
      raid: {
        openRisks: raid.openCounts.risk,
        openIssues: raid.openCounts.issue,
        openChangeRequests: raid.openCounts['change-request'],
        ...(raid.highestOpenSeverity === undefined ? {} : { highestOpenSeverity: raid.highestOpenSeverity }),
      },
      ...(budgetSource ? { budget: toPortfolioBudget(budgetSource) } : {}),
      costHidden,
    }
  })
}

/**
 * Copies the budget fields a row shows.
 *
 * @param source - Budget and cost.
 * @returns The row budget.
 */
function toPortfolioBudget(source: PortfolioBudgetSource): PortfolioProjectBudget {
  return {
    amountMinor: source.budget.amountMinor,
    currency: source.budget.currency,
    ...(source.budget.periodFrom === undefined ? {} : { periodFrom: source.budget.periodFrom }),
    ...(source.budget.periodTo === undefined ? {} : { periodTo: source.budget.periodTo }),
    actualCostMinor: source.actualCostMinor,
    hasOtherCurrencyCost: source.hasOtherCurrencyCost,
  }
}

/** Monthly portfolio snapshot of one Team as stored, before the reader's access is applied. */
export type StoredTeamPortfolioSnapshot = {
  /** Workspace that owns the Team. */
  workspaceId: string
  /** Team whose Projects were captured. */
  teamId: string
  /** Captured month as `YYYY-MM`. */
  month: string
  /** Instant of the capture. */
  capturedAt: string
  /** Rows of every Project the capturing manager could read, with costs they could see. */
  projects: PortfolioProjectMetrics[]
}

/**
 * Applies the current reader's access to a stored snapshot: rows of Projects the reader cannot
 * read are counted and left out, and budgets the reader may not see are removed.
 *
 * @param stored - Stored snapshot.
 * @param canReadProject - Whether the reader may read a Project now.
 * @param canSeeCost - Whether the reader may see a Project's costs now.
 * @returns The snapshot as the reader may see it.
 */
export function redactTeamPortfolioSnapshot(
  stored: StoredTeamPortfolioSnapshot,
  canReadProject: (projectId: string) => boolean,
  canSeeCost: (projectId: string) => boolean,
): TeamPortfolioSnapshot {
  const projects: PortfolioProjectMetrics[] = []
  let hiddenProjectCount = 0
  for (const project of stored.projects) {
    if (!canReadProject(project.projectId)) {
      hiddenProjectCount += 1
      continue
    }
    if (canSeeCost(project.projectId)) {
      projects.push(project)
      continue
    }
    const { projectId, workItems, effort, schedule, nextMilestone, raid } = project
    projects.push({ projectId, workItems, effort, schedule, ...(nextMilestone ? { nextMilestone } : {}), raid, costHidden: true })
  }
  return {
    schemaVersion: PORTFOLIO_DASHBOARD_SCHEMA_VERSION,
    teamId: stored.teamId,
    month: stored.month,
    capturedAt: stored.capturedAt,
    projects,
    hiddenProjectCount,
    costHiddenProjectCount: projects.filter((project) => project.costHidden).length,
  }
}

/** Snapshot write with the caller's authorization fences and audit context. */
export type WriteTeamPortfolioSnapshotInput<TCallerCheck, TAudit> = {
  /** Snapshot to store; it replaces an earlier snapshot of the same month. */
  snapshot: StoredTeamPortfolioSnapshot
  /** Checks committed with the write so a caller who lost access cannot save. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request. */
  auditContext: TAudit
}

/** Persistence of monthly portfolio snapshots. */
export interface TeamPortfolioSnapshotStore<TCallerCheck, TAudit> {
  /**
   * Reads the snapshot of one month.
   *
   * @param workspaceId - Workspace ID.
   * @param teamId - Team ID.
   * @param month - Month as `YYYY-MM`.
   * @returns The snapshot, or `null` when none was saved.
   */
  get(workspaceId: string, teamId: string, month: string): Promise<StoredTeamPortfolioSnapshot | null>
  /**
   * Stores the snapshot of one month, replacing an earlier one.
   *
   * @param input - Snapshot, fences, and audit context.
   */
  put(input: WriteTeamPortfolioSnapshotInput<TCallerCheck, TAudit>): Promise<void>
}
