import {
  AGENT_RUN_ARTIFACT_TYPES,
  AGENT_RUN_RUNTIMES,
  FACTORY_ANALYTICS_STAGES,
  AGENT_RUN_REPORT_KINDS,
  AGENT_RUN_VERIFICATION_STATUSES,
  isAgentRunArtifactUrl,
  type AgentRunArtifact,
  type AgentRunHistoryEntry,
  type AgentRunHistoryFilters,
  type AgentRunOutcome,
  type AgentRunReport,
  type AgentRunReportAnswer,
  type AgentRunRuntime,
  type AgentRunStartedBy,
  type AgentRunUsage,
  type AgentRunVerification,
  type AgentRunView,
  type FactoryAnalyticsOutcomeCounts,
  type FactoryAnalyticsRunSummary,
  type FactoryAnalyticsRuntimeSummary,
  type FactoryAnalyticsStageLeadTime,
  type FactoryAnalyticsUsage,
  type FactoryBoardItem,
  type FactoryBoardReportSummary,
  type FactoryBoardWorkItem,
  type TeamAgentRunBoardResponse,
  type TeamAgentRunHistoryResponse,
  type TeamFactoryAnalyticsResponse,
  type WorkItemAgentRunReportsResponse,
  type WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { isWorkItemStatusCategory } from './contractValidation'
import { WorkItemConfigurationApiError } from './errors'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

const apiBaseUrl = resolveApiBaseUrl()
const runtimes = new Set<string>(['claude-code', 'codex', 'kiro', 'other'])
const outcomes = new Set<string>(['completed', 'paused', 'failed', 'released', 'superseded'])

/**
 * Reads the newest Agent Runs of a Work Item for the signed-in member.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns Runs, newest first, with the actions the member may take.
 */
export async function listWorkItemAgentRuns(
  accessToken: string,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAgentRunsResponse> {
  const data = await requestJson(
    `${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/work-items/${encodeURIComponent(workItemId)}/agent-runs`,
    accessToken,
  )
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.map(readAgentRunView) : undefined
  const usageTotal = isRecord(data) && data.usageTotal !== undefined ? readAgentRunUsage(data.usageTotal) : undefined
  if (
    !isRecord(data) || !items || items.some((item) => item === undefined) || typeof data.hasMore !== 'boolean' ||
    (data.usageTotal !== undefined && usageTotal === undefined)
  ) {
    throw new WorkItemConfigurationApiError(502, 'Agent Run history returned an unexpected response.')
  }
  return {
    items: items.filter((item): item is AgentRunView => item !== undefined),
    hasMore: data.hasMore,
    ...(usageTotal === undefined ? {} : { usageTotal }),
  }
}

/**
 * Reads token usage attributed to a run or a Work Item.
 *
 * @param value - Untrusted value.
 * @returns The usage, or undefined when it is malformed.
 */
function readAgentRunUsage(value: unknown): AgentRunUsage | undefined {
  if (!isRecord(value)) return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, requestCount, estimatedCostMicroUsd, models, hasMore } = value
  if (
    !isNonnegativeSafeInteger(inputTokens) || !isNonnegativeSafeInteger(outputTokens) ||
    !isNonnegativeSafeInteger(cacheReadTokens) || !isNonnegativeSafeInteger(cacheCreationTokens) ||
    !isNonnegativeSafeInteger(requestCount) || typeof hasMore !== 'boolean' ||
    (estimatedCostMicroUsd !== undefined && !isNonnegativeSafeInteger(estimatedCostMicroUsd)) ||
    !Array.isArray(models) || !models.every((model): model is string => typeof model === 'string')
  ) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    requestCount,
    ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
    models,
    hasMore,
  }
}

/**
 * Reads the newest structured reports saved with a Work Item's comments.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns Reports, newest first.
 */
export async function listWorkItemAgentRunReports(
  accessToken: string,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAgentRunReportsResponse> {
  const data = await requestJson(
    `${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/work-items/${encodeURIComponent(workItemId)}/agent-run-reports`,
    accessToken,
  )
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.map(readAgentRunReport) : undefined
  if (!isRecord(data) || !items || typeof data.hasMore !== 'boolean') {
    throw new WorkItemConfigurationApiError(502, 'Agent Run reports returned an unexpected response.')
  }
  const reports = items.filter((item): item is AgentRunReport => item !== undefined)
  if (reports.length !== items.length) {
    throw new WorkItemConfigurationApiError(502, 'Agent Run reports returned an unexpected response.')
  }
  return { items: reports, hasMore: data.hasMore }
}

/**
 * Reads the Factory board of a Team: Work Items with their active or newest run and that run's
 * latest report summary. A malformed item fails the whole response instead of being dropped, so the
 * board never looks emptier than it is.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team ID.
 * @param continuation - Token of the previous page, to read the sources it left unread.
 * @returns Board items, the read bounds the server reached, and the token of the next page.
 */
export async function getTeamAgentRunBoard(
  accessToken: string,
  teamId: string,
  continuation?: string,
): Promise<TeamAgentRunBoardResponse> {
  const query = continuation === undefined ? '' : `?continuation=${encodeURIComponent(continuation)}`
  const data = await requestJson(`${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-runs${query}`, accessToken)
  const board = readTeamAgentRunBoard(data)
  if (!board) throw new WorkItemConfigurationApiError(502, 'The Factory board returned an unexpected response.')
  return board
}

/**
 * Reads the Factory analytics of a Team for a period: outcome rates, rework, interventions, and the
 * median time runs spent in each station, overall and per runtime.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team ID.
 * @param period - UTC ISO 8601 bounds of the period, both inclusive.
 * @param period.from - Start of the period.
 * @param period.to - End of the period.
 * @returns Factory analytics of the period.
 */
export async function getTeamFactoryAnalytics(
  accessToken: string,
  teamId: string,
  period: { from: string; to: string },
): Promise<TeamFactoryAnalyticsResponse> {
  const query = new URLSearchParams({ from: period.from, to: period.to })
  const data = await requestJson(`${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-runs/analytics?${query}`, accessToken)
  const analytics = readTeamFactoryAnalytics(data)
  if (!analytics) throw new WorkItemConfigurationApiError(502, 'Factory analytics returned an unexpected response.')
  return analytics
}

/**
 * Reads the runs of a Team that finished in a period on Work Items the viewer can see, newest finish
 * first. A malformed run fails the whole response instead of being dropped.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team ID.
 * @param request - UTC ISO 8601 bounds of the period, both inclusive, and optional filters.
 * @returns Runs of the period and whether more exist.
 */
export async function getTeamAgentRunHistory(
  accessToken: string,
  teamId: string,
  request: { from: string; to: string } & AgentRunHistoryFilters,
): Promise<TeamAgentRunHistoryResponse> {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(request)) {
    if (typeof value === 'string' && value !== '') query.set(name, value)
  }
  const data = await requestJson(`${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-runs/history?${query}`, accessToken)
  const history = readTeamAgentRunHistory(data, teamId)
  if (!history) throw new WorkItemConfigurationApiError(502, 'The Run history returned an unexpected response.')
  return history
}

/**
 * Validates a Run history response.
 *
 * @param value - Unknown JSON value.
 * @param teamId - Team the request named; a response for another Team is rejected.
 * @returns The history, or undefined when the shape is not supported.
 */
function readTeamAgentRunHistory(value: unknown, teamId: string): TeamAgentRunHistoryResponse | undefined {
  if (!isRecord(value) || value.teamId !== teamId || typeof value.hasMore !== 'boolean' || !Array.isArray(value.runs)) return undefined
  if (typeof value.from !== 'string' || typeof value.to !== 'string' || !Number.isFinite(Date.parse(value.from)) || !Number.isFinite(Date.parse(value.to))) {
    return undefined
  }
  const runs: AgentRunHistoryEntry[] = []
  for (const item of value.runs) {
    const entry = readAgentRunHistoryEntry(item, teamId)
    if (!entry) return undefined
    runs.push(entry)
  }
  return { teamId, from: value.from, to: value.to, runs, hasMore: value.hasMore }
}

/**
 * Validates one finished run of the Run history.
 *
 * @param value - Unknown JSON value.
 * @param teamId - Team of the history.
 * @returns The entry, or undefined when the shape is not supported.
 */
function readAgentRunHistoryEntry(value: unknown, teamId: string): AgentRunHistoryEntry | undefined {
  if (!isRecord(value) || typeof value.workItemTitle !== 'string') return undefined
  if (value.projectId !== undefined && (typeof value.projectId !== 'string' || value.projectId === '')) return undefined
  // The history carries no actions, so the shared run check runs with a fixed, unused release flag.
  const run = readAgentRunView({ ...value, canRelease: false })
  if (!run || run.teamId !== teamId || run.state !== 'finished' || run.finishedAt === undefined || run.outcome === undefined) return undefined
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    teamId: run.teamId,
    workItemId: run.workItemId,
    assigneeUserId: run.assigneeUserId,
    runtime: run.runtime,
    agentName: run.agentName,
    state: run.state,
    outcome: run.outcome,
    startRevision: run.startRevision,
    leaseMinutes: run.leaseMinutes,
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
    stalled: run.stalled,
    finishedAt: run.finishedAt,
    ...(run.finishedBy === undefined ? {} : { finishedBy: run.finishedBy }),
    reportCount: run.reportCount,
    workItemTitle: value.workItemTitle,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
  }
}

/**
 * Checks that a value is null or a finite percentage.
 *
 * @param value - Unknown value.
 * @returns True for null or a number from 0 to 100.
 */
function isRateOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
}

/**
 * Validates finished-run counts per outcome.
 *
 * @param value - Unknown JSON value.
 * @returns Counts, or undefined when any outcome is missing or invalid.
 */
function readOutcomeCounts(value: unknown): FactoryAnalyticsOutcomeCounts | undefined {
  if (!isRecord(value)) return undefined
  const { completed, paused, failed, released, superseded } = value
  if (
    !isNonnegativeSafeInteger(completed) || !isNonnegativeSafeInteger(paused) || !isNonnegativeSafeInteger(failed) ||
    !isNonnegativeSafeInteger(released) || !isNonnegativeSafeInteger(superseded)
  ) {
    return undefined
  }
  return { completed, paused, failed, released, superseded }
}

/**
 * Validates the outcome rates shared by the whole Team and each runtime.
 *
 * @param value - Unknown JSON record.
 * @returns Run summary, or undefined when any part is invalid.
 */
function readRunSummary(value: Record<string, unknown>): FactoryAnalyticsRunSummary | undefined {
  const outcomes = readOutcomeCounts(value.outcomes)
  const { finishedRuns, successRate, reworkRuns, reworkRate, interventions } = value
  if (
    !outcomes || !isNonnegativeSafeInteger(finishedRuns) || !isRateOrNull(successRate) ||
    !isNonnegativeSafeInteger(reworkRuns) || !isRateOrNull(reworkRate) || !isNonnegativeSafeInteger(interventions)
  ) {
    return undefined
  }
  return { finishedRuns, outcomes, successRate, reworkRuns, reworkRate, interventions }
}

/**
 * Validates the dwell time of one station.
 *
 * @param value - Unknown JSON value.
 * @returns Station dwell time, or undefined when it is invalid.
 */
function readStageLeadTime(value: unknown): FactoryAnalyticsStageLeadTime | undefined {
  if (!isRecord(value)) return undefined
  const stage = FACTORY_ANALYTICS_STAGES.find((candidate) => candidate === value.stage)
  const { medianHours, sampleSize } = value
  const validMedian = medianHours === null || (typeof medianHours === 'number' && Number.isFinite(medianHours) && medianHours >= 0)
  if (stage === undefined || !validMedian || !isNonnegativeSafeInteger(sampleSize)) return undefined
  return { stage, medianHours, sampleSize }
}

/**
 * Validates the outcome rates of one runtime.
 *
 * @param value - Unknown JSON value.
 * @returns Runtime summary, or undefined when it is invalid.
 */
function readRuntimeSummary(value: unknown): FactoryAnalyticsRuntimeSummary | undefined {
  if (!isRecord(value)) return undefined
  const runtime = AGENT_RUN_RUNTIMES.find((candidate) => candidate === value.runtime)
  const summary = readRunSummary(value)
  return runtime === undefined || !summary ? undefined : { runtime, ...summary }
}

/**
 * Validates a Factory analytics response. Any malformed part fails the whole response, so the summary
 * never shows numbers it could not read.
 *
 * @param value - Unknown JSON value.
 * @returns The analytics, or undefined when any part is not supported.
 */
function readTeamFactoryAnalytics(value: unknown): TeamFactoryAnalyticsResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.stageLeadTimes) || !Array.isArray(value.runtimes)) return undefined
  const { generatedAt, from, to, finishedRunsHasMore, workItemsHasMore, historyHasMore } = value
  const summary = readRunSummary(value)
  const stageLeadTimes = value.stageLeadTimes.map(readStageLeadTime)
  const runtimes = value.runtimes.map(readRuntimeSummary)
  if (
    !summary ||
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    typeof from !== 'string' || !Number.isFinite(Date.parse(from)) ||
    typeof to !== 'string' || !Number.isFinite(Date.parse(to)) ||
    typeof finishedRunsHasMore !== 'boolean' || typeof workItemsHasMore !== 'boolean' || typeof historyHasMore !== 'boolean'
  ) {
    return undefined
  }
  const validStages = stageLeadTimes.filter((stage): stage is FactoryAnalyticsStageLeadTime => stage !== undefined)
  const validRuntimes = runtimes.filter((runtime): runtime is FactoryAnalyticsRuntimeSummary => runtime !== undefined)
  if (validStages.length !== stageLeadTimes.length || validRuntimes.length !== runtimes.length) return undefined
  const usage = value.usage === undefined ? undefined : readFactoryAnalyticsUsage(value.usage)
  if (value.usage !== undefined && usage === undefined) return undefined
  return {
    generatedAt,
    from,
    to,
    ...summary,
    stageLeadTimes: validStages,
    runtimes: validRuntimes,
    finishedRunsHasMore,
    workItemsHasMore,
    historyHasMore,
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Validates the telemetry usage part of a Factory analytics response.
 *
 * @param value - Unknown JSON value.
 * @returns The usage, or undefined when any part is malformed.
 */
function readFactoryAnalyticsUsage(value: unknown): FactoryAnalyticsUsage | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects) || !Array.isArray(value.workItems) || typeof value.runsHasMore !== 'boolean') {
    return undefined
  }
  const total = readAgentRunUsage(value.total)
  if (!total) return undefined
  const projects: FactoryAnalyticsUsage['projects'] = []
  for (const project of value.projects) {
    if (!isRecord(project) || (project.projectId !== undefined && typeof project.projectId !== 'string')) return undefined
    const usage = readAgentRunUsage(project.usage)
    if (!usage) return undefined
    projects.push({ ...(project.projectId === undefined ? {} : { projectId: project.projectId }), usage })
  }
  const workItems: FactoryAnalyticsUsage['workItems'] = []
  for (const item of value.workItems) {
    if (
      !isRecord(item) || typeof item.workItemId !== 'string' || typeof item.title !== 'string' ||
      (item.projectId !== undefined && typeof item.projectId !== 'string')
    ) {
      return undefined
    }
    const usage = readAgentRunUsage(item.usage)
    if (!usage) return undefined
    workItems.push({
      workItemId: item.workItemId,
      title: item.title,
      ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
      usage,
    })
  }
  return { total, projects, workItems, runsHasMore: value.runsHasMore }
}

/**
 * Validates a Factory board response.
 *
 * @param value - Unknown JSON value.
 * @returns The board, or undefined when any part of it is not supported.
 */
function readTeamAgentRunBoard(value: unknown): TeamAgentRunBoardResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const { generatedAt, activeRunsHasMore, finishedRunsHasMore, startedWorkItemsHasMore, continuation } = value
  if (
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    typeof activeRunsHasMore !== 'boolean' || typeof finishedRunsHasMore !== 'boolean' ||
    typeof startedWorkItemsHasMore !== 'boolean' ||
    (continuation !== undefined && (typeof continuation !== 'string' || continuation === ''))
  ) {
    return undefined
  }
  const items: FactoryBoardItem[] = []
  for (const candidate of value.items) {
    const item = readFactoryBoardItem(candidate)
    if (!item) return undefined
    items.push(item)
  }
  return {
    generatedAt,
    items,
    activeRunsHasMore,
    finishedRunsHasMore,
    startedWorkItemsHasMore,
    ...(continuation === undefined ? {} : { continuation }),
  }
}

/**
 * Validates one Factory board item. Its run and report must describe its own Work Item.
 *
 * @param value - Unknown JSON value.
 * @returns The item, or undefined when the shape is not supported.
 */
function readFactoryBoardItem(value: unknown): FactoryBoardItem | undefined {
  if (!isRecord(value)) return undefined
  const workItem = readFactoryBoardWorkItem(value.workItem)
  const run = value.run === undefined ? undefined : readAgentRunView(value.run)
  const latestReport = value.latestReport === undefined ? undefined : readFactoryBoardReportSummary(value.latestReport)
  if (
    !workItem || (value.run !== undefined && !run) || (value.latestReport !== undefined && !latestReport) ||
    (run !== undefined && run.workItemId !== workItem.id) ||
    (latestReport !== undefined && latestReport.runId !== run?.runId)
  ) {
    return undefined
  }
  return { workItem, ...(run ? { run } : {}), ...(latestReport ? { latestReport } : {}) }
}

/**
 * Validates the Work Item part of a Factory board item.
 *
 * @param value - Unknown JSON value.
 * @returns The Work Item facts, or undefined when the shape is not supported.
 */
function readFactoryBoardWorkItem(value: unknown): FactoryBoardWorkItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, title, workflowStatusId, statusCategory, assignedProjectId, assigneeUserId, assigneeName, assigneeEmail } = value
  if (
    typeof id !== 'string' || id === '' || typeof title !== 'string' ||
    typeof workflowStatusId !== 'string' || workflowStatusId === '' || !isWorkItemStatusCategory(statusCategory) ||
    (assignedProjectId !== undefined && (typeof assignedProjectId !== 'string' || assignedProjectId === '')) ||
    typeof assigneeUserId !== 'string' ||
    (assigneeName !== undefined && (typeof assigneeName !== 'string' || assigneeName === '')) ||
    (assigneeEmail !== undefined && (typeof assigneeEmail !== 'string' || assigneeEmail === ''))
  ) {
    return undefined
  }
  return {
    id,
    title,
    workflowStatusId,
    statusCategory,
    ...(assignedProjectId === undefined ? {} : { assignedProjectId }),
    assigneeUserId,
    ...(assigneeName === undefined ? {} : { assigneeName }),
    ...(assigneeEmail === undefined ? {} : { assigneeEmail }),
  }
}

/**
 * Validates the latest report summary of a Factory board item.
 *
 * @param value - Unknown JSON value.
 * @returns The summary, or undefined when the shape is not supported.
 */
function readFactoryBoardReportSummary(value: unknown): FactoryBoardReportSummary | undefined {
  if (!isRecord(value) || !isRecord(value.verificationCounts)) return undefined
  const { runId, sequence, createdAt, excerpt, artifactCount, changedFileCount } = value
  const { passed, failed, skipped } = value.verificationCounts
  const kind = AGENT_RUN_REPORT_KINDS.find((candidate) => candidate === value.kind)
  if (
    typeof runId !== 'string' || runId === '' || !isPositiveSafeInteger(sequence) || !kind ||
    typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) ||
    (excerpt !== undefined && (typeof excerpt !== 'string' || excerpt === '')) ||
    !isNonnegativeSafeInteger(passed) || !isNonnegativeSafeInteger(failed) || !isNonnegativeSafeInteger(skipped) ||
    !isNonnegativeSafeInteger(artifactCount) ||
    (changedFileCount !== undefined && !isNonnegativeSafeInteger(changedFileCount))
  ) {
    return undefined
  }
  return {
    runId,
    sequence,
    kind,
    createdAt,
    ...(excerpt === undefined ? {} : { excerpt }),
    verificationCounts: { passed, failed, skipped },
    artifactCount,
    ...(changedFileCount === undefined ? {} : { changedFileCount }),
  }
}

/**
 * Releases an active Agent Run so that another agent or person can take over the Work Item.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the run.
 * @param runId - Run to release.
 * @param mutationContext - Idempotency and correlation identifiers shared by retries.
 * @returns The released run.
 */
export async function releaseAgentRun(
  accessToken: string,
  teamId: string,
  runId: string,
  mutationContext: MutationRequestContext,
): Promise<AgentRunView> {
  const data = await requestJson(
    `${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-runs/${encodeURIComponent(runId)}/release`,
    accessToken,
    { method: 'POST', headers: createMutationHeaders(mutationContext) },
  )
  const run = readAgentRunView(data)
  if (!run) throw new WorkItemConfigurationApiError(502, 'Agent Run release returned an unexpected response.')
  return run
}

/**
 * Records a member's answer to a blocker or handoff report. The server saves it on the report and as
 * the member's comment on the Work Item, so the answer reaches the agent and the conversation.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Work Item.
 * @param report - Report being answered.
 * @param body - Answer text.
 * @param mutationContext - Idempotency and correlation identifiers shared by retries.
 * @returns The answered report.
 */
export async function answerAgentRunReport(
  accessToken: string,
  teamId: string,
  report: Pick<AgentRunReport, 'runId' | 'sequence' | 'workItemId'>,
  body: string,
  mutationContext: MutationRequestContext,
): Promise<AgentRunReport> {
  const data = await requestJson(
    `${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/work-items/${encodeURIComponent(report.workItemId)}` +
      `/agent-runs/${encodeURIComponent(report.runId)}/reports/${report.sequence}/answer`,
    accessToken,
    {
      method: 'POST',
      headers: { ...createMutationHeaders(mutationContext), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  )
  const answered = isRecord(data) ? readAgentRunReport(data.report) : undefined
  if (!answered?.answer || answered.runId !== report.runId || answered.sequence !== report.sequence) {
    throw new WorkItemConfigurationApiError(502, 'The report answer returned an unexpected response.')
  }
  return answered
}

/**
 * Validates one run from an untrusted response.
 *
 * @param value - Unknown JSON value.
 * @returns The run, or undefined when the shape is not supported.
 */
function readAgentRunView(value: unknown): AgentRunView | undefined {
  if (!isRecord(value)) return undefined
  /**
   * Reads a non-empty string field.
   *
   * @param name - Field name.
   * @returns The value, or undefined when it is missing or invalid.
   */
  const text = (name: string) => typeof value[name] === 'string' && value[name] !== '' ? value[name] : undefined
  /**
   * Reads an ISO 8601 timestamp field.
   *
   * @param name - Field name.
   * @returns The value, or undefined when it is missing or invalid.
   */
  const time = (name: string) => {
    const candidate = text(name)
    return candidate !== undefined && Number.isFinite(Date.parse(candidate)) ? candidate : undefined
  }
  const runtime = text('runtime')
  const outcome = value.outcome === undefined ? undefined : text('outcome')
  const state = value.state === 'active' || value.state === 'finished' ? value.state : undefined
  const runId = text('runId')
  const teamId = text('teamId')
  const workItemId = text('workItemId')
  const assigneeUserId = text('assigneeUserId')
  const agentName = text('agentName')
  const startedAt = time('startedAt')
  const lastHeartbeatAt = time('lastHeartbeatAt')
  const leaseExpiresAt = time('leaseExpiresAt')
  const finishedAt = value.finishedAt === undefined ? undefined : time('finishedAt')
  const finishedBy = value.finishedBy === undefined ? undefined : text('finishedBy')
  const resumedFromRunId = value.resumedFromRunId === undefined ? undefined : text('resumedFromRunId')
  const usage = value.usage === undefined ? undefined : readAgentRunUsage(value.usage)
  if (value.usage !== undefined && usage === undefined) return undefined
  const startedBy = value.startedBy === undefined ? undefined : readAgentRunStartedBy(value.startedBy)
  if (value.startedBy !== undefined && startedBy === undefined) return undefined
  if (
    value.schemaVersion !== 1 || !runId || !teamId || !workItemId || !assigneeUserId || !agentName ||
    !runtime || !runtimes.has(runtime) || !state || (outcome !== undefined && !outcomes.has(outcome)) ||
    (value.outcome !== undefined && outcome === undefined) || !startedAt || !lastHeartbeatAt || !leaseExpiresAt ||
    (value.finishedAt !== undefined && !finishedAt) || (value.finishedBy !== undefined && !finishedBy) ||
    (value.resumedFromRunId !== undefined && !resumedFromRunId) ||
    !isPositiveSafeInteger(value.startRevision) || !isPositiveSafeInteger(value.leaseMinutes) ||
    !isNonnegativeSafeInteger(value.reportCount) || typeof value.stalled !== 'boolean' || typeof value.canRelease !== 'boolean'
  ) {
    return undefined
  }
  return {
    schemaVersion: 1,
    runId,
    teamId,
    workItemId,
    assigneeUserId,
    runtime: readRuntime(runtime),
    agentName,
    state,
    ...(outcome === undefined ? {} : { outcome: readOutcome(outcome) }),
    startRevision: value.startRevision,
    leaseMinutes: value.leaseMinutes,
    startedAt,
    lastHeartbeatAt,
    leaseExpiresAt,
    stalled: value.stalled,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(finishedBy === undefined ? {} : { finishedBy }),
    reportCount: value.reportCount,
    canRelease: value.canRelease,
    ...(resumedFromRunId === undefined ? {} : { resumedFromRunId }),
    ...(usage === undefined ? {} : { usage }),
    ...(startedBy === undefined ? {} : { startedBy }),
  }
}

/**
 * Validates the credential and instance that started a run, which only Team managers receive.
 *
 * @param value - Unknown JSON value.
 * @returns The starter, or undefined when the shape is not supported.
 */
function readAgentRunStartedBy(value: unknown): AgentRunStartedBy | undefined {
  if (!isRecord(value)) return undefined
  const { credentialId, credentialName, instanceIdHash } = value
  if (
    typeof credentialId !== 'string' || credentialId === '' ||
    (credentialName !== undefined && (typeof credentialName !== 'string' || credentialName === '')) ||
    typeof instanceIdHash !== 'string' || instanceIdHash === ''
  ) {
    return undefined
  }
  return { credentialId, ...(credentialName === undefined ? {} : { credentialName }), instanceIdHash }
}

/**
 * Validates one structured report from an untrusted response. Artifact links must pass the shared
 * URL check, so the page never links to a URL the server would have rejected.
 *
 * @param value - Unknown JSON value.
 * @returns The report, or undefined when the shape is not supported.
 */
function readAgentRunReport(value: unknown): AgentRunReport | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const kind = AGENT_RUN_REPORT_KINDS.find((candidate) => candidate === value.kind)
  const verifications = Array.isArray(value.verifications) ? value.verifications.map(readVerification) : undefined
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts.map(readArtifact) : undefined
  const { runId, teamId, workItemId, commentId, createdAt } = value
  if (
    typeof runId !== 'string' || runId === '' || typeof teamId !== 'string' || teamId === '' ||
    typeof workItemId !== 'string' || workItemId === '' || typeof commentId !== 'string' || commentId === '' ||
    typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) ||
    !kind || !isPositiveSafeInteger(value.sequence) || !verifications || !artifacts ||
    (value.changedFileCount !== undefined && !isNonnegativeSafeInteger(value.changedFileCount))
  ) {
    return undefined
  }
  const validVerifications = verifications.filter((item): item is AgentRunVerification => item !== undefined)
  const validArtifacts = artifacts.filter((item): item is AgentRunArtifact => item !== undefined)
  if (validVerifications.length !== verifications.length || validArtifacts.length !== artifacts.length) return undefined
  const answer = value.answer === undefined ? undefined : readReportAnswer(value.answer)
  if (value.answer !== undefined && !answer) return undefined
  return {
    schemaVersion: 1,
    runId,
    teamId,
    workItemId,
    sequence: value.sequence,
    kind,
    commentId,
    verifications: validVerifications,
    artifacts: validArtifacts,
    ...(value.changedFileCount === undefined ? {} : { changedFileCount: value.changedFileCount }),
    createdAt,
    ...(answer === undefined ? {} : { answer }),
  }
}

/**
 * Validates a person's answer saved on a report.
 *
 * @param value - Unknown JSON value.
 * @returns The answer, or undefined when the shape is not supported.
 */
function readReportAnswer(value: unknown): AgentRunReportAnswer | undefined {
  if (!isRecord(value)) return undefined
  const { body, answeredBy, answeredAt, commentId } = value
  if (
    typeof body !== 'string' || body === '' || typeof answeredBy !== 'string' || answeredBy === '' ||
    typeof answeredAt !== 'string' || !Number.isFinite(Date.parse(answeredAt)) ||
    typeof commentId !== 'string' || commentId === ''
  ) {
    return undefined
  }
  return { body, answeredBy, answeredAt, commentId }
}

/**
 * Validates one verification result of a report.
 *
 * @param value - Unknown JSON value.
 * @returns The verification, or undefined when the shape is not supported.
 */
function readVerification(value: unknown): AgentRunVerification | undefined {
  if (!isRecord(value) || typeof value.command !== 'string' || value.command === '') return undefined
  const status = AGENT_RUN_VERIFICATION_STATUSES.find((candidate) => candidate === value.status)
  if (!status || (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary === ''))) return undefined
  return { command: value.command, status, ...(value.summary === undefined ? {} : { summary: value.summary }) }
}

/**
 * Validates one artifact link of a report.
 *
 * @param value - Unknown JSON value.
 * @returns The artifact, or undefined when the shape or URL is not supported.
 */
function readArtifact(value: unknown): AgentRunArtifact | undefined {
  if (!isRecord(value) || !isAgentRunArtifactUrl(value.url)) return undefined
  const type = AGENT_RUN_ARTIFACT_TYPES.find((candidate) => candidate === value.type)
  if (!type || (value.label !== undefined && (typeof value.label !== 'string' || value.label === ''))) return undefined
  return { type, url: value.url, ...(value.label === undefined ? {} : { label: value.label }) }
}

/**
 * Narrows a validated runtime string.
 *
 * @param value - Runtime known to be supported.
 * @returns Runtime.
 */
function readRuntime(value: string): AgentRunRuntime {
  switch (value) {
    case 'claude-code':
    case 'codex':
    case 'kiro':
      return value
    default:
      return 'other'
  }
}

/**
 * Narrows a validated outcome string.
 *
 * @param value - Outcome known to be supported.
 * @returns Outcome.
 */
function readOutcome(value: string): AgentRunOutcome {
  switch (value) {
    case 'completed':
    case 'paused':
    case 'failed':
    case 'released':
      return value
    default:
      return 'superseded'
  }
}

/**
 * Sends an authenticated request and converts failures to a stable error.
 *
 * @param path - Request URL.
 * @param accessToken - Session access token.
 * @param init - Request options.
 * @returns Parsed JSON body.
 */
async function requestJson(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message = isRecord(data) && typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : 'Unable to complete the Agent Run request.'
    throw new WorkItemConfigurationApiError(
      response.status,
      message,
      isRecord(data) && typeof data.code === 'string' ? data.code : undefined,
    )
  }
  return data
}
