import {
  AGENT_RUN_ARTIFACT_TYPES,
  AGENT_RUN_REPORT_KINDS,
  AGENT_RUN_VERIFICATION_STATUSES,
  isAgentRunArtifactUrl,
  type AgentRunArtifact,
  type AgentRunOutcome,
  type AgentRunReport,
  type AgentRunRuntime,
  type AgentRunVerification,
  type AgentRunView,
  type FactoryBoardItem,
  type FactoryBoardReportSummary,
  type FactoryBoardWorkItem,
  type TeamAgentRunBoardResponse,
  type WorkItemAgentRunReportsResponse,
  type WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { isWorkItemStatusCategory } from './contractValidation'
import { WorkItemConfigurationApiError } from './errors'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '')
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
  if (!isRecord(data) || !items || items.some((item) => item === undefined) || typeof data.hasMore !== 'boolean') {
    throw new WorkItemConfigurationApiError(502, 'Agent Run history returned an unexpected response.')
  }
  return {
    items: items.filter((item): item is AgentRunView => item !== undefined),
    hasMore: data.hasMore,
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
 * @returns Board items and the read bounds the server reached.
 */
export async function getTeamAgentRunBoard(accessToken: string, teamId: string): Promise<TeamAgentRunBoardResponse> {
  const data = await requestJson(`${apiBaseUrl}/teams/${encodeURIComponent(teamId)}/agent-runs`, accessToken)
  const board = readTeamAgentRunBoard(data)
  if (!board) throw new WorkItemConfigurationApiError(502, 'The Factory board returned an unexpected response.')
  return board
}

/**
 * Validates a Factory board response.
 *
 * @param value - Unknown JSON value.
 * @returns The board, or undefined when any part of it is not supported.
 */
function readTeamAgentRunBoard(value: unknown): TeamAgentRunBoardResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const { generatedAt, activeRunsHasMore, finishedRunsHasMore, startedWorkItemsHasMore } = value
  if (
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    typeof activeRunsHasMore !== 'boolean' || typeof finishedRunsHasMore !== 'boolean' ||
    typeof startedWorkItemsHasMore !== 'boolean'
  ) {
    return undefined
  }
  const items: FactoryBoardItem[] = []
  for (const candidate of value.items) {
    const item = readFactoryBoardItem(candidate)
    if (!item) return undefined
    items.push(item)
  }
  return { generatedAt, items, activeRunsHasMore, finishedRunsHasMore, startedWorkItemsHasMore }
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
  const { id, title, workflowStatusId, statusCategory, assignedProjectId, assigneeUserId } = value
  if (
    typeof id !== 'string' || id === '' || typeof title !== 'string' ||
    typeof workflowStatusId !== 'string' || workflowStatusId === '' || !isWorkItemStatusCategory(statusCategory) ||
    (assignedProjectId !== undefined && (typeof assignedProjectId !== 'string' || assignedProjectId === '')) ||
    typeof assigneeUserId !== 'string'
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
  if (
    value.schemaVersion !== 1 || !runId || !teamId || !workItemId || !assigneeUserId || !agentName ||
    !runtime || !runtimes.has(runtime) || !state || (outcome !== undefined && !outcomes.has(outcome)) ||
    (value.outcome !== undefined && outcome === undefined) || !startedAt || !lastHeartbeatAt || !leaseExpiresAt ||
    (value.finishedAt !== undefined && !finishedAt) || (value.finishedBy !== undefined && !finishedBy) ||
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
  }
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
  }
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
