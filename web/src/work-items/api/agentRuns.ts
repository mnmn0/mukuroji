import type {
  AgentRunOutcome,
  AgentRunRuntime,
  AgentRunView,
  WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
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
  const text = (name: string) => typeof value[name] === 'string' && value[name] !== '' ? value[name] : undefined
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
