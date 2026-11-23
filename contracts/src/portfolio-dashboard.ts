import { PROJECT_RAID_SEVERITIES, type ProjectRaidSeverity } from './project-raid-log'

/** Schema version of the portfolio dashboard responses and stored snapshots. */
export const PORTFOLIO_DASHBOARD_SCHEMA_VERSION = 1 as const

/**
 * Most Projects one Team may hold for `GET /api/teams/:teamId/portfolio`. A Team with more fails
 * with `413 PortfolioTooLarge` instead of returning a partial table.
 */
export const PORTFOLIO_TEAM_PROJECT_LIMIT = 200

/**
 * Most Teams the Workspace portfolio dashboard reads at once. With more, the dashboard shows none
 * of them and asks the reader to narrow the Teams instead of comparing a partial Workspace.
 */
export const PORTFOLIO_WORKSPACE_TEAM_LIMIT = 100

/**
 * Most time entries one Team portfolio read totals for budget consumption. A Team with more
 * entries in the budget periods fails with `413 PortfolioTooLarge`.
 */
export const PORTFOLIO_TIME_ENTRY_READ_LIMIT = 20_000

/** Calendar month of a portfolio snapshot, as `YYYY-MM`. */
const PORTFOLIO_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u

/** Local calendar date, as `YYYY-MM-DD`. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/** ISO 4217 currency code. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/u

/** Work Item counts of one Project. */
export type PortfolioProjectWorkItems = {
  /** Every non-archived, non-canceled Work Item assigned to the Project. */
  total: number
  /** Work Items that are neither completed nor canceled. */
  open: number
  /** Work Items in a completed workflow status. */
  completed: number
  /** Open Work Items whose planned end is before today in their schedule calendar. */
  overdueOpen: number
}

/** Effort progress of one Project from the canonical estimates. */
export type PortfolioProjectEffort = {
  /** Number of non-canceled Work Items that carry an estimate. */
  estimatedCount: number
  /** Sum of the estimates of those Work Items, in minutes. */
  plannedMinutes: number
  /** Sum of their remaining effort, in minutes; completed Work Items count as zero. */
  remainingMinutes: number
}

/** Delay of one Project against its active schedule baseline. */
export type PortfolioProjectSchedule = {
  /** Whether the Project has an active schedule baseline. */
  hasBaseline: boolean
  /** Open Work Items whose current planned end is after their baseline end. */
  delayedOpenCount: number
  /** Largest number of days an open Work Item ends after its baseline end; absent when none does. */
  maxDelayDays?: number
}

/** Earliest open Milestone of one Project. */
export type PortfolioProjectMilestone = {
  /** Work Item ID of the Milestone. */
  workItemId: string
  /** Human-readable Work Item key, when assigned. */
  key?: string
  /** Title of the Milestone. */
  title: string
  /** Planned date of the Milestone as `YYYY-MM-DD`. */
  dueDate: string
}

/** Open risk, issue, and change request counts of one Project log. */
export type PortfolioProjectRaid = {
  /** Open risks. */
  openRisks: number
  /** Open issues. */
  openIssues: number
  /** Open change requests. */
  openChangeRequests: number
  /** Severity of the most severe open entry; absent when nothing is open. */
  highestOpenSeverity?: ProjectRaidSeverity
}

/** Budget of one Project and the confidential cost recorded against it. */
export type PortfolioProjectBudget = {
  /** Budget amount in minor currency units. */
  amountMinor: number
  /** ISO 4217 currency code of the budget. */
  currency: string
  /** Inclusive local start of the budget period, when the budget has one. */
  periodFrom?: string
  /** Inclusive local end of the budget period, when the budget has one. */
  periodTo?: string
  /** Billable cost recorded in the budget currency within the period up to now, in minor units. */
  actualCostMinor: number
  /** Whether cost was also recorded in another currency, which the consumption leaves out. */
  hasOtherCurrencyCost: boolean
}

/** Portfolio metrics of one Project the reader may read. */
export type PortfolioProjectMetrics = {
  /** Team-local Project ID. */
  projectId: string
  /** Work Item counts. */
  workItems: PortfolioProjectWorkItems
  /** Effort progress. */
  effort: PortfolioProjectEffort
  /** Delay against the active schedule baseline. */
  schedule: PortfolioProjectSchedule
  /** Earliest open Milestone, when the Project has one with a date. */
  nextMilestone?: PortfolioProjectMilestone
  /** Open entries of the Project log. */
  raid: PortfolioProjectRaid
  /** Budget and cost, when a budget is set and the reader may see the Project's costs. */
  budget?: PortfolioProjectBudget
  /**
   * Whether the reader may not see the Project's budget and cost. The response then says nothing
   * about whether a budget exists.
   */
  costHidden: boolean
}

/** What the reader may do with the Team portfolio. */
export type TeamPortfolioViewer = {
  /** Whether the reader manages the whole Team and may save the month's snapshot. */
  canCaptureSnapshot: boolean
}

/** Response of `GET /api/teams/:teamId/portfolio`. */
export type TeamPortfolioResponse = {
  /** Response schema version. */
  schemaVersion: typeof PORTFOLIO_DASHBOARD_SCHEMA_VERSION
  /** Team whose Projects were summarized. */
  teamId: string
  /** Instant the metrics were computed at. */
  generatedAt: string
  /** IANA timezone used for budget periods. */
  timeZone: string
  /** Metrics of each Project the reader may read, in directory order. */
  projects: PortfolioProjectMetrics[]
  /** Projects of the Team the reader may not read, which the response leaves out. */
  hiddenProjectCount: number
  /** Listed Projects whose budget and cost the reader may not see. */
  costHiddenProjectCount: number
  /** What the reader may do. */
  viewer: TeamPortfolioViewer
}

/** Stored monthly portfolio snapshot of one Team, as the current reader may see it. */
export type TeamPortfolioSnapshot = {
  /** Snapshot schema version. */
  schemaVersion: typeof PORTFOLIO_DASHBOARD_SCHEMA_VERSION
  /** Team whose Projects were captured. */
  teamId: string
  /** Captured calendar month as `YYYY-MM`. */
  month: string
  /** Instant the snapshot was captured at. */
  capturedAt: string
  /** Captured metrics of each Project the reader may read now. */
  projects: PortfolioProjectMetrics[]
  /** Captured Projects the reader may not read now, which the response leaves out. */
  hiddenProjectCount: number
  /** Listed Projects whose budget and cost the reader may not see now. */
  costHiddenProjectCount: number
}

/** Response of `GET /api/teams/:teamId/portfolio/snapshots/:month`. */
export type TeamPortfolioSnapshotResponse = {
  /** The snapshot, or `null` when none was saved for the month. */
  snapshot: TeamPortfolioSnapshot | null
}

/**
 * Tells whether a value is a portfolio snapshot month.
 *
 * @param value - Candidate value.
 * @returns Whether it is a `YYYY-MM` month.
 */
export function isPortfolioMonth(value: unknown): value is string {
  return typeof value === 'string' && PORTFOLIO_MONTH_PATTERN.test(value)
}

/**
 * Returns the month before a portfolio month.
 *
 * @param month - Month as `YYYY-MM`.
 * @returns The previous month as `YYYY-MM`.
 */
export function previousPortfolioMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const previousYear = monthNumber === 1 ? year - 1 : year
  const previousMonth = monthNumber === 1 ? 12 : monthNumber - 1
  return `${String(previousYear).padStart(4, '0')}-${String(previousMonth).padStart(2, '0')}`
}

/**
 * Derives a Project's progress by Work Item count.
 *
 * @param workItems - Work Item counts.
 * @returns An integer percentage, or `undefined` when the Project has no Work Item.
 */
export function derivePortfolioCountProgress(workItems: PortfolioProjectWorkItems): number | undefined {
  return workItems.total === 0 ? undefined : Math.round((workItems.completed * 100) / workItems.total)
}

/**
 * Derives a Project's progress by effort.
 *
 * @param effort - Effort totals.
 * @returns An integer percentage, or `undefined` when no Work Item carries a positive estimate.
 */
export function derivePortfolioEffortProgress(effort: PortfolioProjectEffort): number | undefined {
  if (effort.plannedMinutes <= 0) return undefined
  const done = effort.plannedMinutes - Math.min(effort.plannedMinutes, effort.remainingMinutes)
  return Math.round((done * 100) / effort.plannedMinutes)
}

/**
 * Derives how much of a budget the recorded cost consumed.
 *
 * @param budget - Budget and cost.
 * @returns An integer percentage, or `undefined` for a zero budget.
 */
export function derivePortfolioBudgetConsumption(budget: PortfolioProjectBudget): number | undefined {
  return budget.amountMinor <= 0 ? undefined : Math.round((budget.actualCostMinor * 100) / budget.amountMinor)
}

/**
 * Forecasts the share of a budget spent by the end of its period, extrapolating the cost so far
 * linearly over the elapsed days.
 *
 * @param budget - Budget and cost.
 * @param today - Today as `YYYY-MM-DD` in the budget's calendar.
 * @returns An integer percentage, or `undefined` when the budget has no full period, has not
 *   started, or is zero.
 */
export function forecastPortfolioBudgetConsumption(
  budget: PortfolioProjectBudget,
  today: string,
): number | undefined {
  if (budget.amountMinor <= 0 || budget.periodFrom === undefined || budget.periodTo === undefined) return undefined
  const start = Date.parse(`${budget.periodFrom}T00:00:00Z`)
  const end = Date.parse(`${budget.periodTo}T00:00:00Z`)
  const current = Date.parse(`${today}T00:00:00Z`)
  if (![start, end, current].every(Number.isFinite) || end < start || current < start) return undefined
  const totalDays = (end - start) / 86_400_000 + 1
  const elapsedDays = Math.min(totalDays, (current - start) / 86_400_000 + 1)
  return Math.round((budget.actualCostMinor * totalDays * 100) / (elapsedDays * budget.amountMinor))
}

/**
 * Validates an untrusted Team portfolio response.
 *
 * @param value - Parsed response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseTeamPortfolioResponse(value: unknown): TeamPortfolioResponse | undefined {
  if (!isRecord(value) || value.schemaVersion !== PORTFOLIO_DASHBOARD_SCHEMA_VERSION) return undefined
  const { teamId, generatedAt, timeZone, viewer } = value
  if (
    typeof teamId !== 'string' ||
    !isInstant(generatedAt) ||
    typeof timeZone !== 'string' ||
    !isRecord(viewer) ||
    typeof viewer.canCaptureSnapshot !== 'boolean'
  ) {
    return undefined
  }
  const body = parsePortfolioProjectList(value)
  if (!body) return undefined
  return {
    schemaVersion: PORTFOLIO_DASHBOARD_SCHEMA_VERSION,
    teamId,
    generatedAt,
    timeZone,
    ...body,
    viewer: { canCaptureSnapshot: viewer.canCaptureSnapshot },
  }
}

/**
 * Validates an untrusted Team portfolio snapshot response.
 *
 * @param value - Parsed response body.
 * @returns The response, or `undefined` when any part is malformed.
 */
export function parseTeamPortfolioSnapshotResponse(value: unknown): TeamPortfolioSnapshotResponse | undefined {
  if (!isRecord(value)) return undefined
  if (value.snapshot === null) return { snapshot: null }
  const snapshot = parseTeamPortfolioSnapshot(value.snapshot)
  return snapshot ? { snapshot } : undefined
}

/**
 * Validates an untrusted Team portfolio snapshot.
 *
 * @param value - Candidate snapshot.
 * @returns The snapshot, or `undefined` when any part is malformed.
 */
export function parseTeamPortfolioSnapshot(value: unknown): TeamPortfolioSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== PORTFOLIO_DASHBOARD_SCHEMA_VERSION) return undefined
  const { teamId, month, capturedAt } = value
  if (typeof teamId !== 'string' || !isPortfolioMonth(month) || !isInstant(capturedAt)) return undefined
  const body = parsePortfolioProjectList(value)
  if (!body) return undefined
  return { schemaVersion: PORTFOLIO_DASHBOARD_SCHEMA_VERSION, teamId, month, capturedAt, ...body }
}

/**
 * Validates one untrusted Project row.
 *
 * @param value - Candidate row.
 * @returns The row, or `undefined` when it is malformed.
 */
export function parsePortfolioProjectMetrics(value: unknown): PortfolioProjectMetrics | undefined {
  if (!isRecord(value)) return undefined
  const { projectId, workItems, effort, schedule, nextMilestone, raid, budget, costHidden } = value
  if (typeof projectId !== 'string' || projectId.length === 0 || typeof costHidden !== 'boolean') return undefined
  if (
    !isRecord(workItems) ||
    !isCount(workItems.total) ||
    !isCount(workItems.open) ||
    !isCount(workItems.completed) ||
    !isCount(workItems.overdueOpen)
  ) {
    return undefined
  }
  if (
    !isRecord(effort) ||
    !isCount(effort.estimatedCount) ||
    !isCount(effort.plannedMinutes) ||
    !isCount(effort.remainingMinutes)
  ) {
    return undefined
  }
  if (
    !isRecord(schedule) ||
    typeof schedule.hasBaseline !== 'boolean' ||
    !isCount(schedule.delayedOpenCount) ||
    (schedule.maxDelayDays !== undefined && (!isCount(schedule.maxDelayDays) || schedule.maxDelayDays === 0))
  ) {
    return undefined
  }
  const parsedRaid = parseRaid(raid)
  if (!parsedRaid) return undefined
  let parsedMilestone: PortfolioProjectMilestone | undefined
  if (nextMilestone !== undefined) {
    parsedMilestone = parseMilestone(nextMilestone)
    if (!parsedMilestone) return undefined
  }
  let parsedBudget: PortfolioProjectBudget | undefined
  if (budget !== undefined) {
    if (costHidden) return undefined
    parsedBudget = parseBudget(budget)
    if (!parsedBudget) return undefined
  }
  return {
    projectId,
    workItems: {
      total: workItems.total,
      open: workItems.open,
      completed: workItems.completed,
      overdueOpen: workItems.overdueOpen,
    },
    effort: {
      estimatedCount: effort.estimatedCount,
      plannedMinutes: effort.plannedMinutes,
      remainingMinutes: effort.remainingMinutes,
    },
    schedule: {
      hasBaseline: schedule.hasBaseline,
      delayedOpenCount: schedule.delayedOpenCount,
      ...(typeof schedule.maxDelayDays === 'number' ? { maxDelayDays: schedule.maxDelayDays } : {}),
    },
    ...(parsedMilestone ? { nextMilestone: parsedMilestone } : {}),
    raid: parsedRaid,
    ...(parsedBudget ? { budget: parsedBudget } : {}),
    costHidden,
  }
}

/**
 * Validates the Project list and hidden counts shared by the live response and the snapshot.
 *
 * @param value - Candidate body.
 * @returns The rows and counts, or `undefined` when any part is malformed.
 */
function parsePortfolioProjectList(value: Record<string, unknown>) {
  const { projects, hiddenProjectCount, costHiddenProjectCount } = value
  if (
    !Array.isArray(projects) ||
    projects.length > PORTFOLIO_TEAM_PROJECT_LIMIT ||
    !isCount(hiddenProjectCount) ||
    !isCount(costHiddenProjectCount)
  ) {
    return undefined
  }
  const parsed: PortfolioProjectMetrics[] = []
  for (const candidate of projects) {
    const project = parsePortfolioProjectMetrics(candidate)
    if (!project) return undefined
    parsed.push(project)
  }
  return { projects: parsed, hiddenProjectCount, costHiddenProjectCount }
}

/**
 * Validates untrusted open log counts.
 *
 * @param value - Candidate counts.
 * @returns The counts, or `undefined` when malformed.
 */
function parseRaid(value: unknown): PortfolioProjectRaid | undefined {
  if (!isRecord(value)) return undefined
  const { openRisks, openIssues, openChangeRequests, highestOpenSeverity } = value
  if (!isCount(openRisks) || !isCount(openIssues) || !isCount(openChangeRequests)) return undefined
  const severity = PROJECT_RAID_SEVERITIES.find((candidate) => candidate === highestOpenSeverity)
  if (highestOpenSeverity !== undefined && severity === undefined) return undefined
  return {
    openRisks,
    openIssues,
    openChangeRequests,
    ...(severity === undefined ? {} : { highestOpenSeverity: severity }),
  }
}

/**
 * Validates an untrusted Milestone.
 *
 * @param value - Candidate Milestone.
 * @returns The Milestone, or `undefined` when malformed.
 */
function parseMilestone(value: unknown): PortfolioProjectMilestone | undefined {
  if (!isRecord(value)) return undefined
  const { workItemId, key, title, dueDate } = value
  if (typeof workItemId !== 'string' || workItemId.length === 0 || typeof title !== 'string' || !isLocalDate(dueDate)) {
    return undefined
  }
  if (key !== undefined && typeof key !== 'string') return undefined
  return { workItemId, ...(typeof key === 'string' ? { key } : {}), title, dueDate }
}

/**
 * Validates an untrusted budget.
 *
 * @param value - Candidate budget.
 * @returns The budget, or `undefined` when malformed.
 */
function parseBudget(value: unknown): PortfolioProjectBudget | undefined {
  if (!isRecord(value)) return undefined
  const { amountMinor, currency, periodFrom, periodTo, actualCostMinor, hasOtherCurrencyCost } = value
  if (
    !isCount(amountMinor) ||
    typeof currency !== 'string' ||
    !CURRENCY_PATTERN.test(currency) ||
    !isCount(actualCostMinor) ||
    typeof hasOtherCurrencyCost !== 'boolean' ||
    (periodFrom !== undefined && !isLocalDate(periodFrom)) ||
    (periodTo !== undefined && !isLocalDate(periodTo))
  ) {
    return undefined
  }
  return {
    amountMinor,
    currency,
    ...(typeof periodFrom === 'string' ? { periodFrom } : {}),
    ...(typeof periodTo === 'string' ? { periodTo } : {}),
    actualCostMinor,
    hasOtherCurrencyCost,
  }
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a value is a non-negative safe integer.
 *
 * @param value - Value to check.
 * @returns Whether the value is a count.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Checks whether a value is a parseable timestamp string.
 *
 * @param value - Value to check.
 * @returns Whether the value is an instant.
 */
function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * Checks whether a value is a `YYYY-MM-DD` date.
 *
 * @param value - Value to check.
 * @returns Whether the value is a local date.
 */
function isLocalDate(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_DATE_PATTERN.test(value)
}
