import {
  FACTORY_ANALYTICS_MAX_EVALUATED_FINISHED_RUNS,
  FACTORY_ANALYTICS_MAX_PERIOD_DAYS,
  FACTORY_ANALYTICS_MAX_REPORTS_PER_WORK_ITEM,
  FACTORY_ANALYTICS_MAX_RUNS_PER_WORK_ITEM,
  FACTORY_ANALYTICS_MAX_USAGE_RUNS,
  FACTORY_ANALYTICS_MAX_WORK_ITEMS,
  FACTORY_ANALYTICS_USAGE_TOP_WORK_ITEMS,
  type TeamFactoryAnalyticsResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  calculateFactoryAnalytics,
  createAgentRunIntegrityError,
  summarizeFactoryUsage,
  toAgentRunReport,
  type AgentRunFinishedGroup,
  type FactoryAnalyticsReportFacts,
  type FactoryAnalyticsWorkItemHistory,
} from '../../modules/agent-runs'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { mapInOrderWithConcurrency } from '../shared/agent-run-access'
import { readAgentRunUsage } from '../shared/agent-run-usage-access'
import { workItemDependencies } from '../shared/app-dependencies'
import { canAccessAssignedProject, requireTeamPermission, type WorkspacePrincipal } from '../shared/project-access'
import type { TeamPermissionContext } from '../shared/workspace-access'
import { readAgentRunCostAccess } from '../shared/agent-run-cost-access'

/** Largest page the Agent Run store returns. */
const analyticsPageSize = 100

/** Concurrent per-Work Item reads while the analytics are assembled. */
const analyticsReadConcurrency = 10

/** Milliseconds in one day. */
const millisecondsPerDay = 86_400_000

/** Strict UTC ISO 8601 instant accepted for the period bounds. */
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u

/** Validated analytics period. */
export type FactoryAnalyticsPeriod = {
  /** Start of the period in epoch milliseconds, inclusive. */
  from: number
  /** End of the period in epoch milliseconds, inclusive. */
  to: number
}

/**
 * Reads one period bound from a query parameter.
 *
 * @param value - Raw query value.
 * @param name - Parameter name, used in the error pointer.
 * @returns Epoch milliseconds.
 * @throws AgentRunError when the value is missing or not a UTC ISO 8601 instant.
 */
function readPeriodBound(value: string | undefined, name: 'from' | 'to'): number {
  const instant = value === undefined || !isoInstantPattern.test(value) ? Number.NaN : Date.parse(value)
  if (!Number.isFinite(instant)) {
    throw new AgentRunError('validation_failed', `${name} must be a UTC ISO 8601 instant such as 2026-01-01T00:00:00Z.`, { pointer: `/${name}` })
  }
  return instant
}

/**
 * Validates the period of a Factory analytics request.
 *
 * @param from - Raw `from` query value.
 * @param to - Raw `to` query value.
 * @returns Validated period.
 * @throws AgentRunError when a bound is invalid, the period runs backwards, or it is longer than
 * {@link FACTORY_ANALYTICS_MAX_PERIOD_DAYS} days.
 */
export function readFactoryAnalyticsPeriod(from: string | undefined, to: string | undefined): FactoryAnalyticsPeriod {
  const period = { from: readPeriodBound(from, 'from'), to: readPeriodBound(to, 'to') }
  if (period.to < period.from) {
    throw new AgentRunError('validation_failed', 'to must not be earlier than from.', { pointer: '/to' })
  }
  if (period.to - period.from > FACTORY_ANALYTICS_MAX_PERIOD_DAYS * millisecondsPerDay) {
    throw new AgentRunError('validation_failed', `The period must not be longer than ${FACTORY_ANALYTICS_MAX_PERIOD_DAYS} days.`, { pointer: '/to' })
  }
  return period
}

/**
 * Collects the Work Items of one group of runs that finished in the period, newest finish first, up
 * to {@link FACTORY_ANALYTICS_MAX_EVALUATED_FINISHED_RUNS} evaluated index entries. The index query is
 * bounded by both ends of the period, so runs outside it never use up the budget.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param group - Failed runs or the other finished runs.
 * @param period - Period.
 * @returns Work Item IDs in first-seen order and whether the group was left partly unread.
 */
async function readFinishedRunWorkItemIds(
  principal: WorkspacePrincipal,
  teamId: string,
  group: AgentRunFinishedGroup,
  period: FactoryAnalyticsPeriod,
): Promise<{ workItemIds: string[]; hasMore: boolean }> {
  const workItemIds = new Set<string>()
  const since = new Date(period.from).toISOString()
  const until = new Date(period.to).toISOString()
  let evaluated = 0
  let cursor: string | undefined
  do {
    const limit = Math.min(analyticsPageSize, FACTORY_ANALYTICS_MAX_EVALUATED_FINISHED_RUNS - evaluated)
    const page = await workItemDependencies.agentRuns.listFinishedRunsByTime(principal.directoryId, teamId, group, since, cursor, limit, until)
    evaluated += limit
    for (const run of page.runs) {
      const finishedAt = Date.parse(run.finishedAt)
      if (finishedAt >= period.from && finishedAt <= period.to) workItemIds.add(run.workItemId)
    }
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < FACTORY_ANALYTICS_MAX_EVALUATED_FINISHED_RUNS)
  return { workItemIds: [...workItemIds], hasMore: cursor !== undefined }
}

/** Fields of a visible Work Item that the usage breakdown shows. */
type VisibleWorkItem = {
  /** Work Item title. */
  title: string
  /** Project of the Work Item, when it has one. */
  projectId?: string
}

/**
 * Checks strongly that the viewer can see a Work Item. A deleted Work Item is left out; an archived one
 * keeps counting, because its runs still happened.
 *
 * @param principal - Viewer.
 * @param permission - Viewer's Team permission context.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The Work Item's title and Project when it exists and its Project is visible to the viewer.
 */
async function readVisibleWorkItem(
  principal: WorkspacePrincipal,
  permission: TeamPermissionContext,
  teamId: string,
  workItemId: string,
): Promise<VisibleWorkItem | undefined> {
  try {
    const { issue } = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    if (!canAccessAssignedProject(principal, permission, issue.assignedProjectId, 'viewer')) return undefined
    return { title: issue.title, ...(issue.assignedProjectId === undefined ? {} : { projectId: issue.assignedProjectId }) }
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) return undefined
    throw error
  }
}

/**
 * Reads a Work Item's newest runs and reports up to the per-Work Item bounds. Reports are read only
 * when a run has any.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns History of the Work Item.
 */
async function readWorkItemHistory(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<FactoryAnalyticsWorkItemHistory> {
  const store = workItemDependencies.agentRuns
  const runPage = await store.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, FACTORY_ANALYTICS_MAX_RUNS_PER_WORK_ITEM)
  if (runPage.runs.some((run) => run.workItemId !== workItemId)) throw createAgentRunIntegrityError()
  const reports: FactoryAnalyticsReportFacts[] = []
  if (runPage.runs.some((run) => run.reportCount > 0)) {
    let cursor: string | undefined
    do {
      const limit = Math.min(analyticsPageSize, FACTORY_ANALYTICS_MAX_REPORTS_PER_WORK_ITEM - reports.length)
      const page = await store.listWorkItemReports(principal.directoryId, teamId, workItemId, cursor, limit)
      for (const report of page.reports) {
        if (report.workItemId !== workItemId) throw createAgentRunIntegrityError()
        // Only the fields analytics uses are kept, so verification text and artifact URLs never pile up across Work Items.
        const { runId, sequence, kind, createdAt } = toAgentRunReport(report)
        reports.push({ runId, sequence, kind, createdAt })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined && reports.length < FACTORY_ANALYTICS_MAX_REPORTS_PER_WORK_ITEM)
  }
  return { runs: runPage.runs, runsComplete: runPage.nextCursor === undefined, reports }
}

/**
 * Calculates the Factory analytics of a Team for anyone who can view the Team: the runs that finished
 * in the period on Work Items the viewer can see, with their outcome rates, rework, interventions,
 * station dwell times, and the telemetry usage of those runs. Every source is read up to a fixed
 * bound and the response says when it stopped early; store cursors never leave the server.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param period - Validated period.
 * @returns Factory analytics of the period.
 */
export async function getWebTeamFactoryAnalytics(
  principal: WorkspacePrincipal,
  teamId: string,
  period: FactoryAnalyticsPeriod,
): Promise<TeamFactoryAnalyticsResponse> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  const now = new Date()
  const [failed, other] = await Promise.all([
    readFinishedRunWorkItemIds(principal, teamId, 'failed', period),
    readFinishedRunWorkItemIds(principal, teamId, 'other', period),
  ])
  const workItemIds = [...new Set([...failed.workItemIds, ...other.workItemIds])].sort()
  const evaluatedIds = workItemIds.slice(0, FACTORY_ANALYTICS_MAX_WORK_ITEMS)
  const histories = await mapInOrderWithConcurrency(evaluatedIds, analyticsReadConcurrency, async (workItemId) => {
    const workItem = await readVisibleWorkItem(principal, permission, teamId, workItemId)
    return workItem ? { workItemId, workItem, history: await readWorkItemHistory(principal, teamId, workItemId) } : undefined
  })
  const visible = histories.flatMap((entry) => entry ? [entry] : [])
  const { historyHasMore, ...result } = calculateFactoryAnalytics({
    from: period.from,
    to: period.to,
    histories: visible.map((entry) => entry.history),
  })
  const usage = await readPeriodUsage(principal, teamId, period, visible)
  return {
    generatedAt: now.toISOString(),
    from: new Date(period.from).toISOString(),
    to: new Date(period.to).toISOString(),
    ...result,
    finishedRunsHasMore: failed.hasMore || other.hasMore,
    workItemsHasMore: workItemIds.length > evaluatedIds.length,
    historyHasMore,
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Adds up the telemetry usage of the newest runs that finished in the period, up to
 * {@link FACTORY_ANALYTICS_MAX_USAGE_RUNS}. The estimated cost is read only for the runs the viewer
 * may see it of (ADR 0111); a total, Project, or Work Item shows it only when every run in it does.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param period - Validated period.
 * @param workItems - Visible Work Items with their run histories.
 * @returns The period's usage, or undefined when no run has usage.
 */
async function readPeriodUsage(
  principal: WorkspacePrincipal,
  teamId: string,
  period: FactoryAnalyticsPeriod,
  workItems: readonly { workItemId: string; workItem: VisibleWorkItem; history: FactoryAnalyticsWorkItemHistory }[],
): Promise<TeamFactoryAnalyticsResponse['usage']> {
  const runs = workItems.flatMap(({ workItemId, workItem, history }) => history.runs.flatMap((run) => {
    const finishedAt = run.finishedAt === undefined ? Number.NaN : Date.parse(run.finishedAt)
    return finishedAt >= period.from && finishedAt <= period.to ? [{ run, workItemId, workItem, finishedAt }] : []
  })).sort((left, right) => right.finishedAt - left.finishedAt || (left.run.runId < right.run.runId ? -1 : 1))
  if (runs.length === 0) return undefined
  const evaluated = runs.slice(0, FACTORY_ANALYTICS_MAX_USAGE_RUNS)
  const costAccess = await readAgentRunCostAccess(principal, teamId)
  const usages = await mapInOrderWithConcurrency(evaluated, analyticsReadConcurrency, ({ run, workItem }) =>
    readAgentRunUsage(principal.directoryId, run, costAccess.allows(run, workItem.projectId)))
  return summarizeFactoryUsage(
    evaluated.flatMap(({ workItemId, workItem }, index) => {
      const usage = usages[index]
      return usage ? [{ workItemId, title: workItem.title, ...(workItem.projectId === undefined ? {} : { projectId: workItem.projectId }), usage }] : []
    }),
    FACTORY_ANALYTICS_USAGE_TOP_WORK_ITEMS,
    runs.length > evaluated.length,
  )
}
