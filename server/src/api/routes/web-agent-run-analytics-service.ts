import {
  FACTORY_ANALYTICS_MAX_EVALUATED_FINISHED_RUNS,
  FACTORY_ANALYTICS_MAX_PERIOD_DAYS,
  FACTORY_ANALYTICS_MAX_REPORTS_PER_WORK_ITEM,
  FACTORY_ANALYTICS_MAX_RUNS_PER_WORK_ITEM,
  FACTORY_ANALYTICS_MAX_WORK_ITEMS,
  type TeamFactoryAnalyticsResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  calculateFactoryAnalytics,
  createAgentRunIntegrityError,
  toAgentRunReport,
  type AgentRunFinishedGroup,
  type FactoryAnalyticsReportFacts,
  type FactoryAnalyticsWorkItemHistory,
} from '../../modules/agent-runs'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { mapInOrderWithConcurrency } from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import { canAccessAssignedProject, requireTeamPermission, type WorkspacePrincipal } from '../shared/project-access'
import type { TeamPermissionContext } from '../shared/workspace-access'

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

/**
 * Checks strongly that the viewer can see a Work Item. A deleted Work Item is left out; an archived one
 * keeps counting, because its runs still happened.
 *
 * @param principal - Viewer.
 * @param permission - Viewer's Team permission context.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns True when the Work Item exists and its Project is visible to the viewer.
 */
async function canViewWorkItem(
  principal: WorkspacePrincipal,
  permission: TeamPermissionContext,
  teamId: string,
  workItemId: string,
): Promise<boolean> {
  try {
    const { issue } = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return canAccessAssignedProject(principal, permission, issue.assignedProjectId, 'viewer')
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) return false
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
 * and station dwell times. Token and cost usage are not read. Every source is read up to a fixed
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
  const histories = await mapInOrderWithConcurrency(evaluatedIds, analyticsReadConcurrency, async (workItemId) =>
    await canViewWorkItem(principal, permission, teamId, workItemId)
      ? await readWorkItemHistory(principal, teamId, workItemId)
      : undefined
  )
  const { historyHasMore, ...result } = calculateFactoryAnalytics({
    from: period.from,
    to: period.to,
    histories: histories.flatMap((history) => history ? [history] : []),
  })
  return {
    generatedAt: now.toISOString(),
    from: new Date(period.from).toISOString(),
    to: new Date(period.to).toISOString(),
    ...result,
    finishedRunsHasMore: failed.hasMore || other.hasMore,
    workItemsHasMore: workItemIds.length > evaluatedIds.length,
    historyHasMore,
  }
}
