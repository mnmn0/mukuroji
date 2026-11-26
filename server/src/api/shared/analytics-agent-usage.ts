import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { createAgentRunIntegrityError, type AgentRunFinishedEntry, type AgentRunFinishedGroup } from '../../modules/agent-runs'
import {
  AnalyticsError,
  MAX_ANALYTICS_AGENT_USAGE_RUNS,
  type AnalyticsAgentUsage,
  type AnalyticsAgentUsageRun,
} from '../../modules/analytics'
import { ProjectDataError } from '../../modules/directory'
import { isSoftwareFactoryDeployed } from '../../infrastructure/config/software-factory'
import { mapInOrderWithConcurrency } from './agent-run-access'
import { readAgentRunUsage } from './agent-run-usage-access'
import { workItemDependencies } from './app-dependencies'
import { requireTeamPermission, type WorkspacePrincipal } from './project-access'
import { managesEveryTeamProject } from './team-delegated-management'

/** Largest page the finished-run index returns. */
const AGENT_USAGE_INDEX_PAGE_SIZE = 100

/**
 * Most finished-run index pages one query reads, across Teams and groups. Runs of Work Items the
 * viewer cannot see still fill index pages, so the pages are bounded on their own.
 */
const MAX_AGENT_USAGE_INDEX_PAGES = 100

/** Concurrent run and usage reads while the usage is assembled. */
const AGENT_USAGE_READ_CONCURRENCY = 10

/** Finished-run groups of the index; together they hold every finished run. */
const AGENT_RUN_FINISHED_GROUPS: readonly AgentRunFinishedGroup[] = ['failed', 'other']

/** A finished run of an authorized Work Item, before its usage is read. */
type AgentUsageRunReference = {
  /** Team ID. */
  teamId: string
  /** Finished-run index entry. */
  entry: AgentRunFinishedEntry
}

/**
 * Creates the `413` of a query whose period holds more finished Agent Runs than one query reads.
 *
 * @returns The error.
 */
function createAgentUsageLimitExceededError() {
  return new AnalyticsError(
    413,
    'AnalyticsAgentUsageLimitExceeded',
    `Analytics query has more finished Agent Runs in its period than one query reads (${MAX_ANALYTICS_AGENT_USAGE_RUNS}). Shorten the period or narrow the report scope.`,
  )
}

/**
 * Lists the runs of one Team that finished in the period on authorized Work Items. Fails with `413`
 * once the runs of the whole query pass {@link MAX_ANALYTICS_AGENT_USAGE_RUNS}, instead of adding
 * up a partial total.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @param workItemIds - Authorized Work Item IDs of the Team.
 * @param since - Period start, ISO instant.
 * @param until - Period end, ISO instant.
 * @param collected - Runs collected so far across Teams; the Team's runs are appended.
 * @param budget - Index pages left for the whole query; decremented per page read.
 */
async function collectTeamFinishedRuns(
  directoryId: string,
  teamId: string,
  workItemIds: ReadonlySet<string>,
  since: string,
  until: string,
  collected: AgentUsageRunReference[],
  budget: { indexPages: number },
) {
  const sinceAt = Date.parse(since)
  const untilAt = Date.parse(until)
  for (const group of AGENT_RUN_FINISHED_GROUPS) {
    let cursor: string | undefined
    do {
      if (budget.indexPages <= 0) throw createAgentUsageLimitExceededError()
      budget.indexPages -= 1
      const page = await workItemDependencies.agentRuns.listFinishedRunsByTime(
        directoryId,
        teamId,
        group,
        since,
        cursor,
        AGENT_USAGE_INDEX_PAGE_SIZE,
        until,
      )
      for (const entry of page.runs) {
        const finishedAt = Date.parse(entry.finishedAt)
        if (!(finishedAt >= sinceAt && finishedAt <= untilAt) || !workItemIds.has(entry.workItemId)) continue
        collected.push({ teamId, entry })
        if (collected.length > MAX_ANALYTICS_AGENT_USAGE_RUNS) throw createAgentUsageLimitExceededError()
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
}

/**
 * Reads the telemetry usage of the Agent Runs that finished in the query period on the authorized
 * Work Items (ADR 0061). The estimated cost is read only for Teams the viewer manages, and only when
 * `includeCost` is set. Runs without usage are left out.
 *
 * @param principal - Viewer whose access already bounded `workItems`.
 * @param workItems - Authorized Work Items the query counts; only their runs are read.
 * @param scopeWorkItems - Every authorized Work Item of the query scope. The managed Teams are read
 *   among their Teams, the same set the snapshot permission check reads again.
 * @param period - Normalized query period; its end is already capped at the as-of time.
 * @param includeCost - Whether the query has an `agent-cost` widget.
 * @returns The usage, or undefined when the deployment has no Software factory.
 * @throws AnalyticsError with `413` when the period holds more than
 *   {@link MAX_ANALYTICS_AGENT_USAGE_RUNS} finished runs of the authorized Work Items.
 */
export async function readAuthorizedAnalyticsAgentUsage(
  principal: WorkspacePrincipal,
  workItems: readonly CanonicalWorkItem[],
  scopeWorkItems: readonly CanonicalWorkItem[],
  period: { from: string; to: string },
  includeCost: boolean,
): Promise<AnalyticsAgentUsage | undefined> {
  if (!isSoftwareFactoryDeployed()) return undefined
  const workItemIdsByTeam = new Map<string, Set<string>>()
  for (const item of workItems) {
    const ids = workItemIdsByTeam.get(item.teamId) ?? new Set<string>()
    ids.add(item.id)
    workItemIdsByTeam.set(item.teamId, ids)
  }
  const teams = [...workItemIdsByTeam.entries()].sort(([left], [right]) => left.localeCompare(right))
  const since = new Date(Date.parse(period.from)).toISOString()
  const until = new Date(Date.parse(period.to)).toISOString()
  const references: AgentUsageRunReference[] = []
  const budget = { indexPages: MAX_AGENT_USAGE_INDEX_PAGES }
  for (const [teamId, workItemIds] of teams) {
    await collectTeamFinishedRuns(principal.directoryId, teamId, workItemIds, since, until, references, budget)
  }
  const costTeamIds = includeCost ? await readAnalyticsAgentCostTeamIds(principal, scopeWorkItems) : undefined
  const costTeams = new Set(costTeamIds ?? [])
  const usages = await mapInOrderWithConcurrency(references, AGENT_USAGE_READ_CONCURRENCY, async ({ teamId, entry }) => {
    const run = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, entry.runId)
    // The index is eventually consistent; a run it lists but the table no longer holds adds nothing.
    if (run === undefined) return undefined
    if (run.teamId !== teamId || run.workItemId !== entry.workItemId) throw createAgentRunIntegrityError()
    const finishedAt = run.finishedAt === undefined ? Number.NaN : Date.parse(run.finishedAt)
    if (!Number.isFinite(finishedAt)) return undefined
    const usage = await readAgentRunUsage(principal.directoryId, run, costTeams.has(teamId))
    if (usage === undefined) return undefined
    const usageRun: AnalyticsAgentUsageRun = {
      runId: run.runId,
      finishedAt,
      tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      ...(usage.estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd: usage.estimatedCostMicroUsd }),
      hasMore: usage.hasMore,
    }
    return { key: `${teamId}\0${run.workItemId}`, usageRun }
  })
  const runs = new Map<string, AnalyticsAgentUsageRun[]>()
  for (const usage of usages) {
    if (usage === undefined) continue
    const list = runs.get(usage.key) ?? []
    list.push(usage.usageRun)
    runs.set(usage.key, list)
  }
  return { runs, ...(costTeamIds === undefined ? {} : { costTeamIds }) }
}

/**
 * Reads the Teams whose estimated Agent Run cost the viewer may see among the Teams of the given
 * Work Items, for the permission check of a stored `agent-cost` snapshot.
 *
 * @param principal - Viewer.
 * @param workItems - Currently authorized Work Items of the snapshot query.
 * @returns Managed Team IDs, sorted.
 */
export async function readAnalyticsAgentCostTeamIds(
  principal: WorkspacePrincipal,
  workItems: readonly CanonicalWorkItem[],
): Promise<string[]> {
  const teamIds = [...new Set(workItems.map((item) => item.teamId))].sort()
  return (await mapInOrderWithConcurrency(teamIds, AGENT_USAGE_READ_CONCURRENCY, async (teamId) =>
    await managesTeam(principal, teamId) ? teamId : undefined
  )).flatMap((teamId) => teamId === undefined ? [] : [teamId])
}

/**
 * Checks whether the viewer manages a Team, the role that may see estimated Agent Run cost. The
 * metric adds up the cost of every Project of the Team, so a viewer who manages only some of its
 * Projects does not count as a Team manager (ADR 0087).
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Whether the viewer manages every Project of the Team.
 */
async function managesTeam(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  try {
    const context = await requireTeamPermission(principal, teamId, 'manager')
    // A system administrator's context lists no Project access because it covers every Project.
    return principal.isSystemAdmin || managesEveryTeamProject(context)
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}
