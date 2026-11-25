import {
  AGENT_RUN_HISTORY_MAX_EVALUATED_RUNS,
  AGENT_RUN_HISTORY_MAX_PERIOD_DAYS,
  AGENT_RUN_HISTORY_MAX_RUNS,
  AGENT_RUN_OUTCOMES,
  AGENT_RUN_RUNTIMES,
  type AgentRunHistoryEntry,
  type AgentRunHistoryFilters,
  type AgentRunOutcome,
  type AgentRunRuntime,
  type TeamAgentRunHistoryResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  createAgentRunIntegrityError,
  toAgentRun,
  type AgentRunFinishedEntry,
  type AgentRunFinishedGroup,
} from '../../modules/agent-runs'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { mapInOrderWithConcurrency } from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import { canAccessAssignedProject, requireTeamPermission, type WorkspacePrincipal } from '../shared/project-access'
import type { TeamPermissionContext } from '../shared/workspace-access'

/** Largest page the Agent Run store returns. */
const historyPageSize = 100

/** Concurrent run and Work Item reads while the history is assembled. */
const historyReadConcurrency = 10

/** Milliseconds in one day. */
const millisecondsPerDay = 86_400_000

/** Strict UTC ISO 8601 instant accepted for the period bounds. */
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u

/**
 * Most runs one request reads strongly. A narrow filter can leave most index entries out, so this
 * bound keeps one request's reads small; the rest is reported through `hasMore`.
 */
const maximumHydratedRuns = 600

/** Longest accepted member, Project, or other ID filter. */
const maximumIdLength = 256

/** Validated Run history request. */
export type AgentRunHistoryRequest = {
  /** Start of the period in epoch milliseconds, inclusive. */
  from: number
  /** End of the period in epoch milliseconds, inclusive. */
  to: number
  /** Validated filters. */
  filters: AgentRunHistoryFilters
}

/** Raw query values of a Run history request. */
export type AgentRunHistoryQuery = {
  /** Raw `from`. */
  from: string | undefined
  /** Raw `to`. */
  to: string | undefined
  /** Raw `outcome`. */
  outcome: string | undefined
  /** Raw `assigneeUserId`. */
  assigneeUserId: string | undefined
  /** Raw `runtime`. */
  runtime: string | undefined
  /** Raw `projectId`. */
  projectId: string | undefined
}

/**
 * Reads one period bound.
 *
 * @param value - Raw query value.
 * @param name - Parameter name, used in the error pointer.
 * @returns Epoch milliseconds.
 * @throws AgentRunError when the value is missing or not a UTC ISO 8601 instant.
 */
function readPeriodBound(value: string | undefined, name: 'from' | 'to'): number {
  const instant = value === undefined || !isoInstantPattern.test(value) ? Number.NaN : Date.parse(value)
  // Date.parse rolls a day that does not exist (2026-02-30) into the next month, so the date must read back unchanged.
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value?.slice(0, 10)) {
    throw new AgentRunError('validation_failed', `${name} must be a UTC ISO 8601 instant such as 2026-01-01T00:00:00Z.`, { pointer: `/${name}` })
  }
  return instant
}

/**
 * Reads an optional ID filter.
 *
 * @param value - Raw query value.
 * @param name - Parameter name, used in the error pointer.
 * @returns The trimmed ID, or undefined when absent or empty.
 * @throws AgentRunError when the value is too long or contains control characters.
 */
function readIdFilter(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maximumIdLength || [...trimmed].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new AgentRunError('validation_failed', `${name} is not a valid ID.`, { pointer: `/${name}` })
  }
  return trimmed
}

/**
 * Tells whether a value is a finished-run outcome.
 *
 * @param value - Raw value.
 * @returns True for a known outcome.
 */
function isOutcome(value: string): value is AgentRunOutcome {
  return AGENT_RUN_OUTCOMES.some((outcome) => outcome === value)
}

/**
 * Tells whether a value is a client runtime.
 *
 * @param value - Raw value.
 * @returns True for a known runtime.
 */
function isRuntime(value: string): value is AgentRunRuntime {
  return AGENT_RUN_RUNTIMES.some((runtime) => runtime === value)
}

/**
 * Validates the period and filters of a Run history request.
 *
 * @param query - Raw query values.
 * @returns The validated request.
 * @throws AgentRunError when a bound or filter is invalid, the period runs backwards, or it is
 * longer than {@link AGENT_RUN_HISTORY_MAX_PERIOD_DAYS} days.
 */
export function readAgentRunHistoryRequest(query: AgentRunHistoryQuery): AgentRunHistoryRequest {
  const from = readPeriodBound(query.from, 'from')
  const to = readPeriodBound(query.to, 'to')
  if (to < from) throw new AgentRunError('validation_failed', 'to must not be earlier than from.', { pointer: '/to' })
  if (to - from > AGENT_RUN_HISTORY_MAX_PERIOD_DAYS * millisecondsPerDay) {
    throw new AgentRunError('validation_failed', `The period must not be longer than ${AGENT_RUN_HISTORY_MAX_PERIOD_DAYS} days.`, { pointer: '/to' })
  }
  const outcome = query.outcome?.trim() || undefined
  if (outcome !== undefined && !isOutcome(outcome)) {
    throw new AgentRunError('validation_failed', `outcome must be one of ${AGENT_RUN_OUTCOMES.join(', ')}.`, { pointer: '/outcome' })
  }
  const runtime = query.runtime?.trim() || undefined
  if (runtime !== undefined && !isRuntime(runtime)) {
    throw new AgentRunError('validation_failed', `runtime must be one of ${AGENT_RUN_RUNTIMES.join(', ')}.`, { pointer: '/runtime' })
  }
  const assigneeUserId = readIdFilter(query.assigneeUserId, 'assigneeUserId')
  const projectId = readIdFilter(query.projectId, 'projectId')
  return {
    from,
    to,
    filters: {
      ...(outcome === undefined ? {} : { outcome }),
      ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(projectId === undefined ? {} : { projectId }),
    },
  }
}

/**
 * Reads one group of the finished-run index for the period, newest finish first, up to
 * {@link AGENT_RUN_HISTORY_MAX_EVALUATED_RUNS} entries. The query is bounded by both ends of the
 * period, so runs outside it never use up the budget.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param group - Failed runs or the other finished runs.
 * @param request - Validated request.
 * @returns Index entries in the period and whether the group was left partly unread.
 */
async function readFinishedEntries(
  principal: WorkspacePrincipal,
  teamId: string,
  group: AgentRunFinishedGroup,
  request: AgentRunHistoryRequest,
): Promise<{ entries: AgentRunFinishedEntry[]; hasMore: boolean }> {
  const since = new Date(request.from).toISOString()
  const until = new Date(request.to).toISOString()
  const entries: AgentRunFinishedEntry[] = []
  let evaluated = 0
  let cursor: string | undefined
  do {
    const limit = Math.min(historyPageSize, AGENT_RUN_HISTORY_MAX_EVALUATED_RUNS - evaluated)
    const page = await workItemDependencies.agentRuns.listFinishedRunsByTime(principal.directoryId, teamId, group, since, cursor, limit, until)
    evaluated += limit
    for (const entry of page.runs) {
      const finishedAt = Date.parse(entry.finishedAt)
      if (finishedAt >= request.from && finishedAt <= request.to) entries.push(entry)
    }
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < AGENT_RUN_HISTORY_MAX_EVALUATED_RUNS)
  return { entries, hasMore: cursor !== undefined }
}

/**
 * Selects the index groups a filter needs; failed runs have their own group.
 *
 * @param outcome - Outcome filter.
 * @returns Groups to read.
 */
function groupsFor(outcome: AgentRunOutcome | undefined): AgentRunFinishedGroup[] {
  if (outcome === undefined) return ['failed', 'other']
  return outcome === 'failed' ? ['failed'] : ['other']
}

/** Work Item fields the history shows, or undefined when the viewer may not see the Work Item. */
type VisibleWorkItem = {
  /** Work Item title. */
  title: string
  /** Project of the Work Item, when it has one. */
  projectId?: string
}

/**
 * Checks strongly that the viewer can see a Work Item. A deleted Work Item is left out; an archived
 * one stays, because its runs still happened.
 *
 * @param principal - Viewer.
 * @param permission - Viewer's Team permission context.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The Work Item's title and Project, or undefined.
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
 * Lists the runs of a Team that finished in the period on Work Items the viewer can see, newest
 * finish first, for anyone who can view the Team. Index entries are read up to a fixed bound, each
 * run and Work Item is read strongly, and the filters apply to the stored run, so a run that the
 * index lists but that no longer matches is left out. Store cursors never leave the server.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param request - Validated period and filters.
 * @returns Up to {@link AGENT_RUN_HISTORY_MAX_RUNS} runs and whether more exist.
 */
export async function getWebTeamAgentRunHistory(
  principal: WorkspacePrincipal,
  teamId: string,
  request: AgentRunHistoryRequest,
): Promise<TeamAgentRunHistoryResponse> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  const { filters } = request
  const groups = await Promise.all(groupsFor(filters.outcome).map((group) => readFinishedEntries(principal, teamId, group, request)))
  const candidates = groups.flatMap((group) => group.entries)
    .filter((entry) => filters.outcome === undefined || entry.outcome === filters.outcome)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || left.runId.localeCompare(right.runId))
  const now = new Date()
  const workItems = new Map<string, Promise<VisibleWorkItem | undefined>>()
  const runs: AgentRunHistoryEntry[] = []
  let index = 0
  let overflow = false
  // Candidates are read in batches until the response is full, so a narrow filter still fills it.
  while (index < candidates.length && index < maximumHydratedRuns && runs.length < AGENT_RUN_HISTORY_MAX_RUNS) {
    const batch = candidates.slice(index, Math.min(index + historyReadConcurrency * 2, maximumHydratedRuns))
    index += batch.length
    const read = await mapInOrderWithConcurrency(batch, historyReadConcurrency, async (entry) => {
      const stored = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, entry.runId)
      if (stored === undefined) return undefined
      if (stored.workItemId !== entry.workItemId) throw createAgentRunIntegrityError()
      const run = toAgentRun(stored, now)
      if (run.state !== 'finished') return undefined
      if (filters.outcome !== undefined && run.outcome !== filters.outcome) return undefined
      if (filters.assigneeUserId !== undefined && run.assigneeUserId !== filters.assigneeUserId) return undefined
      if (filters.runtime !== undefined && run.runtime !== filters.runtime) return undefined
      let workItem = workItems.get(run.workItemId)
      if (workItem === undefined) {
        workItem = readVisibleWorkItem(principal, permission, teamId, run.workItemId)
        workItems.set(run.workItemId, workItem)
      }
      const visible = await workItem
      if (visible === undefined) return undefined
      if (filters.projectId !== undefined && visible.projectId !== filters.projectId) return undefined
      return {
        ...run,
        workItemTitle: visible.title,
        ...(visible.projectId === undefined ? {} : { projectId: visible.projectId }),
      } satisfies AgentRunHistoryEntry
    })
    for (const entry of read) {
      if (entry === undefined) continue
      if (runs.length < AGENT_RUN_HISTORY_MAX_RUNS) runs.push(entry)
      else overflow = true
    }
  }
  return {
    teamId,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    runs,
    hasMore: overflow || groups.some((group) => group.hasMore) || index < candidates.length,
  }
}
