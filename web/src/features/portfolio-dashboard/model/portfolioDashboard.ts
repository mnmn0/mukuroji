import {
  DEFAULT_PROJECT_LIFECYCLE_STATE,
  derivePortfolioBudgetConsumption,
  derivePortfolioCountProgress,
  derivePortfolioEffortProgress,
  forecastPortfolioBudgetConsumption,
  PROJECT_RAID_SEVERITIES,
  type PlanningEntity,
  type PlanningHealth,
  type PlanningUpdateTargetSummary,
  type PortfolioProjectMetrics,
  type ProjectLifecycleState,
  type TeamAgentRunBoardResponse,
  type TeamPortfolioResponse,
  type TeamPortfolioSnapshot,
  type WorkspaceWorkloadSnapshot,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import { summarizeProjectOverviewAgentRuns } from '../../../projects/model/projectOverview'

/** Result of reading one Team's live portfolio. */
export type TeamPortfolioRead = {
  /** Team ID. */
  teamId: string
  /** Portfolio, when the read succeeded. */
  portfolio?: TeamPortfolioResponse
  /** Failure of the portfolio read, when it failed. */
  error?: unknown
  /** Factory board of the Team, when Software factory is on and the read succeeded. */
  agentBoard?: TeamAgentRunBoardResponse
  /** Whether the Factory board read failed. */
  agentBoardFailed: boolean
  /** Failure of the Factory board read, kept so session failures reach the Workspace shell. */
  agentBoardError?: unknown
}

/** Result of reading one Team's snapshot of the compared month. */
export type TeamPortfolioSnapshotRead = {
  /** Team ID. */
  teamId: string
  /** The snapshot, `null` when none was saved, or undefined when the read failed. */
  snapshot?: TeamPortfolioSnapshot | null
  /** Whether the read failed. */
  failed: boolean
  /** Failure of the read, kept so session failures reach the Workspace shell. */
  error?: unknown
}

/**
 * Lists every failure the portfolio reads kept, so the Workspace shell can react to an expired
 * or denied session while each Team's ordinary failure stays a notice on the dashboard.
 *
 * @param reads - Team portfolio reads.
 * @param snapshots - Snapshot reads of the compared month.
 * @returns The failures, in Team order.
 */
export function listPortfolioDashboardErrors(
  reads: readonly TeamPortfolioRead[],
  snapshots: readonly TeamPortfolioSnapshotRead[],
): unknown[] {
  return [
    ...reads.flatMap((read) => [read.error, read.agentBoardError].filter((error) => error !== undefined)),
    ...snapshots.flatMap((read) => read.error === undefined ? [] : [read.error]),
  ]
}

/** State of the Workspace portfolio reads. */
export type PortfolioDashboardReads = {
  /** Whether the Workspace has more Teams than the dashboard reads at once. */
  tooManyTeams: boolean
  /** One read per Team, in the given order. */
  teams: TeamPortfolioRead[]
}

/** Default budget consumption, in percent, above which a row is highlighted. */
export const DEFAULT_PORTFOLIO_BUDGET_THRESHOLD = 90

/** Default delay, in days behind the baseline, above which a row is highlighted. */
export const DEFAULT_PORTFOLIO_DELAY_THRESHOLD_DAYS = 3

/** Columns the dashboard table sorts by. */
export const PORTFOLIO_DASHBOARD_SORT_KEYS = [
  'project',
  'team',
  'health',
  'progress',
  'effort',
  'delay',
  'budget',
  'forecast',
  'risks',
  'milestone',
  'utilization',
] as const

/** Column the dashboard table sorts by. */
export type PortfolioDashboardSortKey = (typeof PORTFOLIO_DASHBOARD_SORT_KEYS)[number]

/** Sort order of the dashboard table. */
export type PortfolioDashboardSort = {
  /** Column. */
  key: PortfolioDashboardSortKey
  /** Whether larger or later values come first. */
  descending: boolean
}

/** Portfolio (Planning entity) that a Project belongs to. */
export type PortfolioDashboardPortfolio = {
  /** Planning entity ID. */
  id: string
  /** Title of the Portfolio. */
  title: string
}

/** Agent Run counts of one Project from its Team's Factory board. */
export type PortfolioDashboardAgentRuns = {
  /** Work Items whose latest run failed. */
  failed: number
  /** Work Items whose run stalled. */
  stalled: number
  /** Whether the board stopped at a read bound, so the counts can be low. */
  isIncomplete: boolean
}

/** Workload of the members allocated to one Project in the current month, across every Team. */
export type PortfolioDashboardUtilization = {
  /** Members with an allocation to the Project in the month. */
  memberCount: number
  /**
   * Those members' allocation across every Team divided by their Workspace-wide capacity, in
   * percent; absent when they have no capacity in the month.
   */
  percent?: number
  /** Those members who are over capacity in the month once every Team counts. */
  overloadedMemberCount: number
}

/** Change of a row since the compared month's snapshot. */
export type PortfolioDashboardDelta = {
  /** Change of the count progress, in percentage points. */
  progress?: number
  /** Change of the budget consumption, in percentage points. */
  budget?: number
  /** Change of the largest delay, in days. */
  delay?: number
  /** Change of the open risks and issues. */
  risks?: number
}

/** One Project row of the Workspace portfolio dashboard. */
export type PortfolioDashboardRow = {
  /** Team-qualified key, unique across the Workspace. */
  key: string
  /** Team that owns the Project. */
  teamId: string
  /** Team name. */
  teamName: string
  /** Team-local Project ID. */
  projectId: string
  /** Project name, or its ID when the directory does not list it. */
  projectName: string
  /** Lifecycle state of the Project. */
  lifecycleState: ProjectLifecycleState
  /** Accountable Project manager named in the charter, when any. */
  ownerName?: string
  /** Portfolios the Project belongs to in Planning. */
  portfolios: PortfolioDashboardPortfolio[]
  /** Health reported by the latest Planning update. */
  health: PlanningHealth
  /** Current metrics. */
  metrics: PortfolioProjectMetrics
  /** Metrics of the compared month's snapshot, when it holds the Project. */
  previous?: PortfolioProjectMetrics
  /** Progress by Work Item count, in percent. */
  countProgress?: number
  /** Progress by effort, in percent. */
  effortProgress?: number
  /** Budget consumed so far, in percent. */
  budgetConsumption?: number
  /** Budget forecast at the end of its period, in percent. */
  budgetForecast?: number
  /** Agent Run counts, when Software factory is on and the board was read. */
  agentRuns?: PortfolioDashboardAgentRuns
  /** Workload of the Project's members this month, when the Workspace workload was read. */
  utilization?: PortfolioDashboardUtilization
  /** Change since the compared month. */
  delta?: PortfolioDashboardDelta
}

/** Rows of the dashboard and what the reader could not see. */
export type PortfolioDashboardModel = {
  /** One row per readable Project across the read Teams. */
  rows: PortfolioDashboardRow[]
  /** Projects left out because the reader may not read them. */
  hiddenProjectCount: number
  /** Listed Projects whose budget and cost the reader may not see. */
  costHiddenProjectCount: number
  /** Teams whose portfolio could not be read. */
  failedTeamNames: string[]
  /** Teams whose portfolio is too large to list. */
  tooLargeTeamNames: string[]
  /** Teams whose compared-month snapshot could not be read. */
  failedSnapshotTeamNames: string[]
  /** Projects of the compared month's snapshots that the reader may not read now. */
  snapshotHiddenProjectCount: number
  /** Whether a Factory board read failed, so some Agent Run counts are missing. */
  agentRunsIncomplete: boolean
  /** Whether the Workspace workload could not be read, so utilization is missing. */
  utilizationUnavailable: boolean
}

/** Inputs of {@link createPortfolioDashboardModel}. */
export type PortfolioDashboardModelInput = {
  /** Directory Teams and Projects, in directory order. */
  teams: readonly ProjectDirectoryTeam[]
  /** Live portfolio reads. */
  reads: readonly TeamPortfolioRead[]
  /** Compared-month snapshot reads, when a month is compared. */
  snapshots?: readonly TeamPortfolioSnapshotRead[]
  /** Planning update projections, when they could be read. */
  updateTargets?: readonly PlanningUpdateTargetSummary[]
  /** Visible Planning entities, used to find each Project's Portfolios. */
  planningEntities?: readonly PlanningEntity[]
  /** Today in the reader's calendar, as `YYYY-MM-DD`. */
  today: string
  /** Workspace workload of the current month at month granularity, when it could be read. */
  workload?: WorkspaceWorkloadSnapshot
  /** Whether the Workspace workload read failed. */
  workloadFailed?: boolean
}

/**
 * Joins the Team portfolio reads with the directory, Planning, Factory boards, and the compared
 * month's snapshots into one row per Project.
 *
 * @param input - Reads and directory.
 * @returns The rows and what the reader could not see.
 */
export function createPortfolioDashboardModel(input: PortfolioDashboardModelInput): PortfolioDashboardModel {
  const teamsById = new Map(input.teams.map((team) => [team.id, team] as const))
  const snapshotsByTeam = new Map((input.snapshots ?? []).map((read) => [read.teamId, read] as const))
  const portfoliosByProject = indexProjectPortfolios(input.planningEntities ?? [])
  const utilizationByProject = input.workload ? summarizePortfolioUtilization(input.workload) : undefined
  const rows: PortfolioDashboardRow[] = []
  const failedTeamNames: string[] = []
  const tooLargeTeamNames: string[] = []
  const failedSnapshotTeamNames: string[] = []
  let hiddenProjectCount = 0
  let costHiddenProjectCount = 0
  let snapshotHiddenProjectCount = 0
  let agentRunsIncomplete = false

  for (const read of input.reads) {
    const team = teamsById.get(read.teamId)
    const teamName = team?.name ?? read.teamId
    if (!read.portfolio) {
      if (isTooLarge(read.error)) tooLargeTeamNames.push(teamName)
      else failedTeamNames.push(teamName)
      continue
    }
    hiddenProjectCount += read.portfolio.hiddenProjectCount
    costHiddenProjectCount += read.portfolio.costHiddenProjectCount
    if (read.agentBoardFailed) agentRunsIncomplete = true
    const snapshotRead = snapshotsByTeam.get(read.teamId)
    if (snapshotRead?.failed) failedSnapshotTeamNames.push(teamName)
    const snapshot = snapshotRead?.snapshot ?? undefined
    if (snapshot) snapshotHiddenProjectCount += snapshot.hiddenProjectCount
    const previousByProject = new Map((snapshot?.projects ?? []).map((project) => [project.projectId, project] as const))

    for (const metrics of read.portfolio.projects) {
      const directoryProject = team?.projects.find((project) => project.id === metrics.projectId)
      const updateTarget = input.updateTargets?.find((candidate) =>
        candidate.target.type === 'project' &&
        candidate.target.teamId === read.teamId &&
        candidate.target.projectId === metrics.projectId)
      const previous = previousByProject.get(metrics.projectId)
      const countProgress = derivePortfolioCountProgress(metrics.workItems)
      const effortProgress = derivePortfolioEffortProgress(metrics.effort)
      const budgetConsumption = metrics.budget ? derivePortfolioBudgetConsumption(metrics.budget) : undefined
      const budgetForecast = metrics.budget ? forecastPortfolioBudgetConsumption(metrics.budget, input.today) : undefined
      const ownerName = directoryProject?.charter?.owner?.displayName
      const agentRuns = read.agentBoard
        ? summarizeProjectOverviewAgentRuns(read.agentBoard, metrics.projectId)
        : undefined
      const utilization = utilizationByProject
        ? utilizationByProject.get(`${read.teamId}/${metrics.projectId}`) ?? { memberCount: 0, overloadedMemberCount: 0 }
        : undefined
      rows.push({
        key: `${read.teamId}/${metrics.projectId}`,
        teamId: read.teamId,
        teamName,
        projectId: metrics.projectId,
        projectName: directoryProject?.name ?? metrics.projectId,
        lifecycleState: directoryProject?.lifecycleState ?? DEFAULT_PROJECT_LIFECYCLE_STATE,
        ...(ownerName ? { ownerName } : {}),
        portfolios: portfoliosByProject.get(`${read.teamId}/${metrics.projectId}`) ?? [],
        health: updateTarget?.latestUpdate?.health ?? 'unknown',
        metrics,
        ...(previous ? { previous } : {}),
        ...(countProgress === undefined ? {} : { countProgress }),
        ...(effortProgress === undefined ? {} : { effortProgress }),
        ...(budgetConsumption === undefined ? {} : { budgetConsumption }),
        ...(budgetForecast === undefined ? {} : { budgetForecast }),
        ...(agentRuns
          ? {
              agentRuns: {
                failed: agentRuns.laneCounts.failed,
                stalled: agentRuns.laneCounts.stalled,
                isIncomplete: agentRuns.isIncomplete,
              },
            }
          : {}),
        ...(utilization ? { utilization } : {}),
        ...(previous ? { delta: createDelta(metrics, previous) } : {}),
      })
    }
  }

  return {
    rows,
    hiddenProjectCount,
    costHiddenProjectCount,
    failedTeamNames,
    tooLargeTeamNames,
    failedSnapshotTeamNames,
    snapshotHiddenProjectCount,
    agentRunsIncomplete,
    utilizationUnavailable: input.workloadFailed === true,
  }
}

/**
 * Sums, per Team-qualified Project, the Workspace-wide workload of the members the Project has
 * allocations for. A member's whole load counts, not only the Project's share, so the column shows
 * whether the Project's people are stretched by work elsewhere too. Only Project shares the reader
 * may see name a member, so hidden Projects and confidential assignments name no one.
 *
 * @param workload - Workspace workload of the month.
 * @returns Utilization keyed by `teamId/projectId`.
 */
export function summarizePortfolioUtilization(
  workload: WorkspaceWorkloadSnapshot,
): Map<string, PortfolioDashboardUtilization> {
  const totals = new Map<string, { members: number; capacity: number; allocated: number; overloaded: number }>()
  for (const member of workload.members) {
    const projectKeys = new Set<string>()
    for (const cell of member.cells) {
      for (const share of cell.projects) {
        if (share.projectId !== undefined && share.allocatedMinutes > 0) projectKeys.add(`${share.teamId}/${share.projectId}`)
      }
    }
    for (const key of projectKeys) {
      const total = totals.get(key) ?? { members: 0, capacity: 0, allocated: 0, overloaded: 0 }
      total.members += 1
      total.capacity += member.capacityMinutes
      total.allocated += member.allocatedMinutes
      if (member.overloaded) total.overloaded += 1
      totals.set(key, total)
    }
  }
  const result = new Map<string, PortfolioDashboardUtilization>()
  for (const [key, total] of totals) {
    result.set(key, {
      memberCount: total.members,
      ...(total.capacity > 0 ? { percent: Math.round((total.allocated / total.capacity) * 100) } : {}),
      overloadedMemberCount: total.overloaded,
    })
  }
  return result
}

/**
 * Tells whether a Team read failed because the Team is larger than one portfolio lists.
 *
 * @param error - Read failure.
 * @returns Whether the server answered 413.
 */
function isTooLarge(error: unknown) {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'status') === 413
}

/**
 * Compares a row with its snapshot.
 *
 * @param current - Current metrics.
 * @param previous - Snapshot metrics.
 * @returns The changes that both sides can measure.
 */
function createDelta(current: PortfolioProjectMetrics, previous: PortfolioProjectMetrics): PortfolioDashboardDelta {
  const currentProgress = derivePortfolioCountProgress(current.workItems)
  const previousProgress = derivePortfolioCountProgress(previous.workItems)
  const currentBudget = current.budget ? derivePortfolioBudgetConsumption(current.budget) : undefined
  const previousBudget = previous.budget && current.budget?.currency === previous.budget.currency
    ? derivePortfolioBudgetConsumption(previous.budget)
    : undefined
  return {
    ...(currentProgress === undefined || previousProgress === undefined ? {} : { progress: currentProgress - previousProgress }),
    ...(currentBudget === undefined || previousBudget === undefined ? {} : { budget: currentBudget - previousBudget }),
    delay: (current.schedule.maxDelayDays ?? 0) - (previous.schedule.maxDelayDays ?? 0),
    risks: openRiskCount(current) - openRiskCount(previous),
  }
}

/**
 * Counts the open risks and issues of a row.
 *
 * @param metrics - Row metrics.
 * @returns Open risks plus open issues.
 */
export function openRiskCount(metrics: PortfolioProjectMetrics) {
  return metrics.raid.openRisks + metrics.raid.openIssues
}

/**
 * Maps each Team-qualified Project to the Portfolios above the Planning entities that reference it.
 *
 * @param entities - Visible Planning entities.
 * @returns Portfolios keyed by `teamId/projectId`.
 */
function indexProjectPortfolios(entities: readonly PlanningEntity[]) {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity] as const))
  const result = new Map<string, PortfolioDashboardPortfolio[]>()
  for (const entity of entities) {
    if (entity.teamId === undefined || entity.projectId === undefined) continue
    const portfolio = findPortfolioAncestor(entity, entitiesById)
    if (!portfolio) continue
    const key = `${entity.teamId}/${entity.projectId}`
    const list = result.get(key) ?? []
    if (!list.some((candidate) => candidate.id === portfolio.id)) list.push({ id: portfolio.id, title: portfolio.title })
    result.set(key, list)
  }
  return result
}

/**
 * Walks parent links to the nearest visible Portfolio, the entity itself included.
 *
 * @param entity - Entity whose Portfolio is resolved.
 * @param entitiesById - Visible entities by ID.
 * @returns The nearest Portfolio, or undefined when none is visible.
 */
function findPortfolioAncestor(
  entity: PlanningEntity,
  entitiesById: ReadonlyMap<string, PlanningEntity>,
): PlanningEntity | undefined {
  const visited = new Set<string>()
  let current: PlanningEntity | undefined = entity
  while (current && !visited.has(current.id)) {
    if (current.type === 'portfolio') return current
    visited.add(current.id)
    current = current.parentId === undefined ? undefined : entitiesById.get(current.parentId)
  }
  return undefined
}

/** Row filters of the dashboard. */
export type PortfolioDashboardFilters = {
  /** Team ID, or `all`. */
  teamId: string
  /** Lifecycle state, or `all`. */
  lifecycle: ProjectLifecycleState | 'all'
  /** Reported health, or `all`. */
  health: PlanningHealth | 'all'
  /** Portfolio entity ID, `none` for Projects outside any Portfolio, or `all`. */
  portfolioId: string
  /** Whether only rows over a threshold are kept. */
  attentionOnly: boolean
}

/** Thresholds that highlight rows. */
export type PortfolioDashboardThresholds = {
  /** Budget consumption or forecast, in percent, above which a row is highlighted. */
  budgetPercent: number
  /** Delay in days above which a row is highlighted. */
  delayDays: number
}

/** Threshold breaches of one row. */
export type PortfolioDashboardAttention = {
  /** Whether the budget consumption or forecast is over the threshold. */
  budget: boolean
  /** Whether the largest delay is over the threshold. */
  delay: boolean
  /** Whether a member allocated to the Project is over capacity this month. */
  utilization: boolean
}

/**
 * Decides which thresholds a row breaches.
 *
 * @param row - Dashboard row.
 * @param thresholds - Thresholds.
 * @returns The breaches.
 */
export function evaluatePortfolioDashboardAttention(
  row: PortfolioDashboardRow,
  thresholds: PortfolioDashboardThresholds,
): PortfolioDashboardAttention {
  const budgetValue = Math.max(row.budgetConsumption ?? 0, row.budgetForecast ?? 0)
  return {
    budget: row.budgetConsumption !== undefined && budgetValue > thresholds.budgetPercent,
    delay: (row.metrics.schedule.maxDelayDays ?? 0) > thresholds.delayDays,
    utilization: (row.utilization?.overloadedMemberCount ?? 0) > 0,
  }
}

/** Rank of each reported health value, worst first. */
const healthRank: Record<PlanningHealth, number> = { 'off-track': 0, 'at-risk': 1, unknown: 2, 'on-track': 3 }

/**
 * Reads the sortable value of a row; `undefined` sorts last in either direction.
 *
 * @param row - Dashboard row.
 * @param key - Column.
 * @returns A number or string to compare.
 */
function readSortValue(row: PortfolioDashboardRow, key: PortfolioDashboardSortKey): number | string | undefined {
  switch (key) {
    case 'project':
      return row.projectName
    case 'team':
      return row.teamName
    case 'health':
      return healthRank[row.health]
    case 'progress':
      return row.countProgress
    case 'effort':
      return row.effortProgress
    case 'delay':
      return row.metrics.schedule.maxDelayDays ?? 0
    case 'budget':
      return row.budgetConsumption
    case 'forecast':
      return row.budgetForecast
    case 'risks':
      return openRiskCount(row.metrics) * 10 + PROJECT_RAID_SEVERITIES.indexOf(row.metrics.raid.highestOpenSeverity ?? 'low')
    case 'milestone':
      return row.metrics.nextMilestone?.dueDate
    case 'utilization':
      return row.utilization?.percent
  }
}

/**
 * Filters and sorts rows without changing the input.
 *
 * @param rows - Rows in directory order.
 * @param filters - Row filters.
 * @param thresholds - Thresholds used by `attentionOnly`.
 * @param sort - Sort order.
 * @returns The matching rows in order.
 */
export function arrangePortfolioDashboardRows(
  rows: readonly PortfolioDashboardRow[],
  filters: PortfolioDashboardFilters,
  thresholds: PortfolioDashboardThresholds,
  sort: PortfolioDashboardSort,
): PortfolioDashboardRow[] {
  const filtered = rows.filter((row) => {
    if (filters.teamId !== 'all' && row.teamId !== filters.teamId) return false
    if (filters.lifecycle !== 'all' && row.lifecycleState !== filters.lifecycle) return false
    if (filters.health !== 'all' && row.health !== filters.health) return false
    if (filters.portfolioId === 'none' && row.portfolios.length > 0) return false
    if (
      filters.portfolioId !== 'all' &&
      filters.portfolioId !== 'none' &&
      !row.portfolios.some((portfolio) => portfolio.id === filters.portfolioId)
    ) {
      return false
    }
    if (filters.attentionOnly) {
      const attention = evaluatePortfolioDashboardAttention(row, thresholds)
      if (!attention.budget && !attention.delay && !attention.utilization) return false
    }
    return true
  })
  return filtered.sort((left, right) => {
    const leftValue = readSortValue(left, sort.key)
    const rightValue = readSortValue(right, sort.key)
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue !== rightValue) return leftValue === undefined ? 1 : -1
    } else if (leftValue !== rightValue) {
      const order = typeof leftValue === 'string' && typeof rightValue === 'string'
        ? leftValue.localeCompare(rightValue)
        : Number(leftValue) - Number(rightValue)
      return sort.descending ? -order : order
    }
    return left.projectName.localeCompare(right.projectName) || left.teamName.localeCompare(right.teamName)
  })
}

/**
 * Lists the Portfolios that the rows belong to, for the filter.
 *
 * @param rows - Dashboard rows.
 * @returns Distinct Portfolios ordered by title.
 */
export function listPortfolioDashboardPortfolios(rows: readonly PortfolioDashboardRow[]): PortfolioDashboardPortfolio[] {
  const byId = new Map<string, PortfolioDashboardPortfolio>()
  for (const row of rows) for (const portfolio of row.portfolios) byId.set(portfolio.id, portfolio)
  return [...byId.values()].sort((left, right) => left.title.localeCompare(right.title))
}

/** Columns of the CSV export, in order. */
export const PORTFOLIO_DASHBOARD_CSV_COLUMNS = [
  'project',
  'team',
  'lifecycle',
  'health',
  'owner',
  'workItems',
  'completed',
  'overdue',
  'progress',
  'effortProgress',
  'delayedOpen',
  'maxDelayDays',
  'budget',
  'currency',
  'actualCost',
  'budgetConsumption',
  'budgetForecast',
  'openRisks',
  'openIssues',
  'highestSeverity',
  'nextMilestone',
  'nextMilestoneDate',
  'agentRunsFailed',
  'agentRunsStalled',
  'utilizationPercent',
  'utilizationMembers',
  'overloadedMembers',
  'progressDelta',
  'budgetDelta',
  'delayDelta',
  'risksDelta',
] as const

/** Column of the CSV export. */
export type PortfolioDashboardCsvColumn = (typeof PORTFOLIO_DASHBOARD_CSV_COLUMNS)[number]

/**
 * Formats the rows as CSV. Costs the reader may not see stay empty.
 *
 * @param rows - Rows to export, in display order.
 * @param headerLabel - Turns a column into its header text.
 * @param formatLabel - Turns a lifecycle state or health into display text.
 * @returns CSV text with a header row.
 */
export function createPortfolioDashboardCsv(
  rows: readonly PortfolioDashboardRow[],
  headerLabel: (column: PortfolioDashboardCsvColumn) => string,
  formatLabel: (kind: 'lifecycle' | 'health', value: string) => string,
): string {
  const header = PORTFOLIO_DASHBOARD_CSV_COLUMNS.map(headerLabel)
  const lines = rows.map((row) => {
    const { metrics } = row
    return [
      row.projectName,
      row.teamName,
      formatLabel('lifecycle', row.lifecycleState),
      formatLabel('health', row.health),
      row.ownerName,
      metrics.workItems.total,
      metrics.workItems.completed,
      metrics.workItems.overdueOpen,
      row.countProgress,
      row.effortProgress,
      metrics.schedule.delayedOpenCount,
      metrics.schedule.maxDelayDays ?? 0,
      metrics.budget?.amountMinor,
      metrics.budget?.currency,
      metrics.budget?.actualCostMinor,
      row.budgetConsumption,
      row.budgetForecast,
      metrics.raid.openRisks,
      metrics.raid.openIssues,
      metrics.raid.highestOpenSeverity,
      metrics.nextMilestone?.title,
      metrics.nextMilestone?.dueDate,
      row.agentRuns?.failed,
      row.agentRuns?.stalled,
      row.utilization?.percent,
      row.utilization?.memberCount,
      row.utilization?.overloadedMemberCount,
      row.delta?.progress,
      row.delta?.budget,
      row.delta?.delay,
      row.delta?.risks,
    ]
  })
  return [header, ...lines].map((cells) => cells.map(toCsvCell).join(',')).join('\r\n')
}

/**
 * Quotes one CSV cell and neutralizes values a spreadsheet would run as a formula.
 *
 * @param value - Cell value.
 * @returns The quoted cell.
 */
function toCsvCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
