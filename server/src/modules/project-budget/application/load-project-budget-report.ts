import {
  deriveWorkItemProgressPercent,
  type ProjectBudgetReport,
  type ProjectBudgetReportInterval,
  type ProjectExpense,
  type ProjectScheduleBaseline,
  type TimeBudget,
  type TimeEntry,
  type WorkItemEffortFields,
  type WorkItemProgressMode,
  type WorkspaceAgentCostSettings,
} from '@mukuroji/contracts'
import { splitTimeEntryByLocalDate } from '../../time-tracking'
import {
  createProjectBudgetReport,
  measureProjectEarnedValueMinutes,
  type ProjectBudgetReportInput,
  type ProjectEarnedValueMinutes,
  type ProjectBudgetTimeEntry,
  type ProjectBudgetWorkItemProgress,
} from '../project-budget-report'
import {
  MAX_PROJECT_AGENT_COST_RUNS,
  resolveProjectAgentCostRate,
  toProjectAgentRunCosts,
  type ProjectAgentCostInput,
  type ProjectAgentRunCostReader,
  projectAgentRunFinishDateTest,
} from '../project-agent-cost'

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000

/**
 * Widest offset of any IANA timezone from UTC, in milliseconds. Entries are read this far
 * around the UTC dates and then kept by their local date.
 */
const MAX_TIMEZONE_OFFSET_MS = 14 * 3_600_000

/** A validated report request of a caller already authorized to manage the Project. */
export type ProjectBudgetReportRequest = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project ID within the Team. */
  projectId: string
  /** First local date, `YYYY-MM-DD`. */
  from: string
  /** Last local date, `YYYY-MM-DD`. */
  to: string
  /** IANA timezone the dates are in. */
  timeZone: string
  /** Series bucket. */
  interval: ProjectBudgetReportInterval
}

/** One Work Item as the report reads it to derive progress. */
export type ProjectBudgetWorkItem = WorkItemEffortFields & {
  /** Work Item ID. */
  id: string
  /** Project the Work Item belongs to now, if any. */
  assignedProjectId?: string
}

/** One page of a Team's Work Items, archived ones included. */
export type ProjectBudgetWorkItemPage = {
  /** Work Items on the page. */
  issues: readonly ProjectBudgetWorkItem[]
  /** Rows evaluated to build the page, when the store reports it. */
  evaluatedCount?: number
  /** Cursor of the next page; absent on the last page. */
  nextStartAfterIssueId?: string
}

/** Reads the report needs, scoped to one Team. */
export type ProjectBudgetReportPorts = {
  /** Reads the budget of the Project in the Team. */
  getBudget(workspaceId: string, teamId: string, projectId: string): Promise<TimeBudget | undefined>
  /** Reads the active schedule baseline of the Project. */
  getBaseline(workspaceId: string, teamId: string, projectId: string): Promise<ProjectScheduleBaseline | null>
  /** Reads how the Team derives Work Item progress. */
  getProgressMode(workspaceId: string, teamId: string): Promise<WorkItemProgressMode | undefined>
  /** Lists every time entry of the Project that starts within the UTC instants. */
  listEntries(input: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Project ID. */
    projectId: string
    /** Inclusive lower instant, ISO 8601. */
    from: string
    /** Upper instant, ISO 8601. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of the Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
  /** Reads one page of the Team's Work Items, archived ones included. */
  listWorkItems(workspaceId: string, teamId: string, startAfterIssueId: string | undefined): Promise<ProjectBudgetWorkItemPage>
  /** Reads how the Workspace counts coding agent cost (ADR 0119); undefined when never saved. */
  readAgentCostSettings?(workspaceId: string): Promise<WorkspaceAgentCostSettings | undefined>
  /** Reads Agent Run cost; absent when the deployment has no Software factory. */
  listAgentRunCosts?: ProjectAgentRunCostReader
  /** Returns the current time. */
  now(): Date
}

/** Error codes the use case raises. */
export type ProjectBudgetReportErrorCode = 'WorkItemListLimitExceeded' | 'WorkItemListReadStalled'

/** A failure while loading the report that is not the caller's input. */
export class ProjectBudgetReportError extends Error {
  /** HTTP-like status: 413 for too many Work Items, 503 for a read that did not advance. */
  readonly status: 413 | 503
  /** Stable error code. */
  readonly code: ProjectBudgetReportErrorCode

  /**
   * Creates the error.
   *
   * @param status - Status of the failure.
   * @param code - Stable error code.
   * @param message - Explanation.
   */
  constructor(status: 413 | 503, code: ProjectBudgetReportErrorCode, message: string) {
    super(message)
    this.name = 'ProjectBudgetReportError'
    this.status = status
    this.code = code
  }
}

/**
 * Loads the budget, baseline, progress, and time of a Project and builds its budget report.
 *
 * The caller must already have checked that the principal manages the Project.
 *
 * @param request - Validated request.
 * @param ports - Team-scoped reads.
 * @param workItemLimit - Most Work Items one report may evaluate.
 * @returns The report.
 * @throws ProjectBudgetReportError when the Team has too many Work Items or a page read stalls.
 */
export async function loadProjectBudgetReport(
  request: ProjectBudgetReportRequest,
  ports: ProjectBudgetReportPorts,
  workItemLimit: number,
): Promise<ProjectBudgetReport> {
  const { workspaceId, teamId, projectId } = request
  const [budget, baseline] = await Promise.all([
    ports.getBudget(workspaceId, teamId, projectId),
    ports.getBaseline(workspaceId, teamId, projectId),
  ])
  return createProjectBudgetReport(
    await readReportInput(request, ports, workItemLimit, budget ?? null, baseline, ports.now().getTime(), true),
  )
}

/** A validated earned value request of a caller already authorized to manage the Project. */
export type ProjectEarnedValueRequest = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project ID within the Team. */
  projectId: string
  /** IANA timezone the as-of date is taken in. */
  timeZone: string
  /** Instant the figures are measured at, epoch milliseconds. */
  asOf: number
}

/**
 * First local date the earned value of a Project counts recorded time from: in practice every
 * entry the Project has, so actual time is the Project's total to date.
 */
const PROJECT_TO_DATE_FROM = '2000-01-01'

/**
 * Loads the exact earned value figures of a Project at an instant, the same way the budget report
 * calculates them, so a caller can add Projects up before it rounds.
 *
 * Actual time is every minute recorded on the Project through the as-of date. Earned value reads
 * the Work Items' current progress, so the caller measures only at a recent as-of instant
 * (ADR 0110). Expenses and Agent Run cost are not read, because the figures are in effort. The
 * caller must already have checked that the principal manages the Project.
 *
 * @param request - Validated request.
 * @param ports - Team-scoped reads.
 * @param workItemLimit - Most Work Items one Project may evaluate.
 * @returns The figures, or `null` without a baseline that plans any effort.
 * @throws ProjectBudgetReportError when the Team has too many Work Items or a page read stalls.
 */
export async function loadProjectEarnedValue(
  request: ProjectEarnedValueRequest,
  ports: ProjectBudgetReportPorts,
  workItemLimit: number,
): Promise<ProjectEarnedValueMinutes | null> {
  const { workspaceId, teamId, projectId, timeZone } = request
  const [budget, baseline] = await Promise.all([
    ports.getBudget(workspaceId, teamId, projectId),
    ports.getBaseline(workspaceId, teamId, projectId),
  ])
  if (baseline === null || !baseline.entries.some((entry) => (entry.plannedEffortMinutes ?? 0) > 0)) return null
  const asOfDate = localDateAt(request.asOf, timeZone)
  const from = asOfDate < PROJECT_TO_DATE_FROM ? asOfDate : PROJECT_TO_DATE_FROM
  return measureProjectEarnedValueMinutes(await readReportInput(
    { workspaceId, teamId, projectId, from, to: asOfDate, timeZone, interval: 'week' },
    ports,
    workItemLimit,
    budget ?? null,
    baseline,
    request.asOf,
    false,
  ))
}

/**
 * Reads the progress, time, and expenses of a Project and assembles the budget report input from
 * the budget and baseline already read.
 *
 * @param request - Validated request.
 * @param ports - Team-scoped reads.
 * @param workItemLimit - Most Work Items one report may evaluate.
 * @param budget - Project budget, or `null`.
 * @param baseline - Active schedule baseline, or `null`.
 * @param now - Instant whose local date is the report's today, epoch milliseconds.
 * @param includeMoneyInputs - Whether to read the inputs that count only in money, the Project
 *   expenses and the Agent Run cost; without them neither counts.
 * @returns The report input.
 * @throws ProjectBudgetReportError when the Team has too many Work Items or a page read stalls.
 */
async function readReportInput(
  request: ProjectBudgetReportRequest,
  ports: ProjectBudgetReportPorts,
  workItemLimit: number,
  budget: TimeBudget | null,
  baseline: ProjectScheduleBaseline | null,
  now: number,
  includeMoneyInputs: boolean,
): Promise<ProjectBudgetReportInput> {
  const { workspaceId, teamId, projectId, timeZone } = request
  // Agent Run cost counts only in money, so only the report reads it, and only when the Workspace
  // counts it and the deployment can read Agent Runs (ADR 0119).
  const agentCostRate = includeMoneyInputs && budget && ports.listAgentRunCosts && ports.readAgentCostSettings
    ? resolveProjectAgentCostRate(await ports.readAgentCostSettings(workspaceId), budget.currency)
    : undefined
  const [progressMode, entries, expenses] = await Promise.all([
    ports.getProgressMode(workspaceId, teamId),
    ports.listEntries({
      workspaceId,
      teamId,
      projectId,
      from: new Date(Date.parse(`${request.from}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString(),
      to: new Date(Date.parse(`${request.to}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
    }),
    includeMoneyInputs ? ports.listExpenses(workspaceId, teamId, projectId) : Promise.resolve([]),
  ])
  const baselineIds = new Set((baseline?.entries ?? []).map((entry) => entry.workItemId))
  const { progress: workItems, projectWorkItemIds } = baselineIds.size === 0 && agentCostRate === undefined
    ? { progress: new Map<string, ProjectBudgetWorkItemProgress>(), projectWorkItemIds: new Set<string>() }
    : await readWorkItemProgress(request, ports, baselineIds, progressMode, workItemLimit)
  const today = localDateAt(now, timeZone)
  let agentCost: ProjectAgentCostInput | undefined
  if (agentCostRate !== undefined && ports.listAgentRunCosts) {
    const asOf = today < request.to ? today : request.to
    // A report period that starts after today has no finished runs yet.
    const read = projectWorkItemIds.size === 0 || today < request.from
      ? { runs: [], truncated: false }
      : await ports.listAgentRunCosts({
          workspaceId,
          teamId,
          workItemIds: projectWorkItemIds,
          since: new Date(Date.parse(`${request.from}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString(),
          until: new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
          countsFinishedAt: projectAgentRunFinishDateTest(timeZone, request.from, asOf),
          maxRuns: MAX_PROJECT_AGENT_COST_RUNS,
        })
    agentCost = { usdExchangeRate: agentCostRate.usdExchangeRate, costs: toProjectAgentRunCosts(read, timeZone) }
  }
  return {
    teamId,
    projectId,
    from: request.from,
    to: request.to,
    timeZone,
    interval: request.interval,
    today,
    budget,
    baseline,
    workItems,
    entries: entries.flatMap((entry) => toBudgetEntries(entry, timeZone)),
    expenses,
    ...(agentCost === undefined ? {} : { agentCost }),
  }
}

/**
 * Reads the current progress of the baseline Work Items, archived ones included, because
 * archiving finished work must not take back what it earned, and the IDs of every Work Item the
 * Project holds now, whose Agent Runs the budget may count (ADR 0119).
 *
 * @param request - Report request.
 * @param ports - Team-scoped reads.
 * @param ids - Work Item IDs the baseline holds.
 * @param progressMode - Team progress mode.
 * @param limit - Most Work Items one report may evaluate.
 * @returns Progress keyed by Work Item ID, where deleted Work Items are missing, and the Project's
 *   Work Item IDs.
 * @throws ProjectBudgetReportError when the Team has too many Work Items or a page read stalls.
 */
async function readWorkItemProgress(
  request: ProjectBudgetReportRequest,
  ports: ProjectBudgetReportPorts,
  ids: ReadonlySet<string>,
  progressMode: WorkItemProgressMode | undefined,
  limit: number,
): Promise<{ progress: Map<string, ProjectBudgetWorkItemProgress>; projectWorkItemIds: Set<string> }> {
  const result = new Map<string, ProjectBudgetWorkItemProgress>()
  const projectWorkItemIds = new Set<string>()
  let evaluated = 0
  let startAfterIssueId: string | undefined
  do {
    const page = await ports.listWorkItems(request.workspaceId, request.teamId, startAfterIssueId)
    evaluated += page.evaluatedCount ?? page.issues.length
    if (evaluated > limit) {
      throw new ProjectBudgetReportError(
        413,
        'WorkItemListLimitExceeded',
        `Team has more than ${limit} Work Items to report on. Refine the Workspace before loading the aggregate Work Item list.`,
      )
    }
    for (const issue of page.issues) {
      if (issue.assignedProjectId === request.projectId) projectWorkItemIds.add(issue.id)
      // A Work Item moved to another Project earns nothing here, like a deleted one, so the report
      // never reads the state of work the Project no longer owns.
      if (!ids.has(issue.id) || issue.assignedProjectId !== request.projectId) continue
      result.set(issue.id, {
        canceled: issue.statusCategory === 'canceled',
        progressPercent: deriveWorkItemProgressPercent(issue, progressMode) ?? 0,
      })
    }
    if (page.nextStartAfterIssueId !== undefined && page.nextStartAfterIssueId === startAfterIssueId) {
      throw new ProjectBudgetReportError(503, 'WorkItemListReadStalled', `Team "${request.teamId}" Work Item read did not advance.`)
    }
    startAfterIssueId = page.nextStartAfterIssueId
  } while (startAfterIssueId !== undefined)
  return { progress: result, projectWorkItemIds }
}

/**
 * Converts a time entry to what the report reads: one part per local date it covers in the
 * report timezone, split at midnight the way time reports split it. Each part keeps its share of
 * the cost: the rate times its minutes when the entry has a rate, else the cost split by time.
 *
 * @param entry - Stored time entry.
 * @param timeZone - Report timezone.
 * @returns The report entries.
 */
function toBudgetEntries(entry: TimeEntry, timeZone: string): ProjectBudgetTimeEntry[] {
  return splitTimeEntryByLocalDate(entry, timeZone).map((segment) => {
    const actualCostMinor = entry.actualCostMinor === undefined
      ? undefined
      : entry.hourlyRateMinor === undefined
        ? Math.round(entry.actualCostMinor * segment.ratio)
        : Math.round((segment.minutes / 60) * entry.hourlyRateMinor)
    return {
      localDate: segment.date,
      durationMinutes: segment.minutes,
      currency: entry.currency,
      ...(actualCostMinor === undefined ? {} : { actualCostMinor }),
    }
  })
}

/** Cached local date formatters by timezone. */
const localDateFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Formats an instant as a local date.
 *
 * @param timestamp - Epoch milliseconds.
 * @param timeZone - IANA timezone.
 * @returns `YYYY-MM-DD` in the timezone.
 */
function localDateAt(timestamp: number, timeZone: string): string {
  let formatter = localDateFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    localDateFormatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(timestamp))
}
