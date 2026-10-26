import { z } from 'zod'
import {
  AGENT_RUN_PROBLEM_REASONS, AGENT_SETTINGS_BRIEF_MAX_BYTES, AGENT_SETTINGS_MAX_PROJECT_BRIEFS, AGENT_SETTINGS_MAX_READY_STATUSES,
} from '@mukuroji/contracts'
import type {
  AgentCatalog, AgentPage, AgentRunRecord, AgentRunReportResult, AgentSettingsRecord, AgentTask, AgentWorkItemApi,
} from '../../application/work-item-api'
import { AgentTaskError } from '../../application/work-item-api'

const identifier = z.string().min(1).max(256).refine((value) => value !== '.' && value !== '..')
const category = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled'])
const customValue = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string()).max(100)])
const taskSchema: z.ZodType<AgentTask> = z.object({
  id: identifier, teamId: identifier, revision: z.number().int().positive(),
  title: z.string(), description: z.string().optional(), assigneeUserId: identifier,
  assignedProjectId: identifier.optional(), workflowStatusId: identifier,
  workItemTypeId: identifier.optional(), statusCategory: category,
  priority: z.enum(['high', 'medium', 'low']), dueDate: z.union([z.literal(''), z.iso.date()]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  relationIds: z.array(z.string().regex(/^(parent|child|blocks|blockedBy|related|duplicate):.+$/)).max(100),
  customFieldValues: z.record(z.string(), customValue),
})
const catalogSchema: z.ZodType<AgentCatalog> = z.object({
  teamId: identifier, configurationRevision: z.number().int().nonnegative(),
  workItemTypes: z.array(z.object({
    id: identifier, name: z.string(),
    workflow: z.object({
      initialStatusId: identifier,
      statuses: z.array(z.object({
        id: identifier, name: z.string(), category, sortOrder: z.number(), color: z.string().optional(),
      })),
    }),
    customFields: z.array(z.record(z.string(), z.unknown())),
  })),
})
const commentSchema = z.object({
  id: identifier, actorUserId: identifier, body: z.string(), createdAt: z.iso.datetime(),
})
const runSchema: z.ZodType<AgentRunRecord> = z.object({
  schemaVersion: z.literal(1), runId: z.string().regex(/^run_[0-9a-f-]{36}$/u), teamId: identifier,
  workItemId: identifier, assigneeUserId: identifier,
  runtime: z.enum(['claude-code', 'codex', 'kiro', 'other']), agentName: z.string().min(1).max(64),
  state: z.enum(['active', 'finished']),
  outcome: z.enum(['completed', 'paused', 'failed', 'released', 'superseded']).optional(),
  startRevision: z.number().int().positive(), leaseMinutes: z.number().int().positive(),
  startedAt: z.iso.datetime(), lastHeartbeatAt: z.iso.datetime(), leaseExpiresAt: z.iso.datetime(),
  stalled: z.boolean(), finishedAt: z.iso.datetime().optional(), finishedBy: z.string().min(1).optional(),
  reportCount: z.number().int().nonnegative(),
})
const reportResultSchema: z.ZodType<AgentRunReportResult> = z.object({
  report: z.object({
    schemaVersion: z.literal(1), runId: z.string().regex(/^run_[0-9a-f-]{36}$/u), teamId: identifier, workItemId: identifier,
    sequence: z.number().int().positive(), kind: z.enum(['progress', 'blocker', 'verification', 'artifact', 'handoff']),
    commentId: identifier,
    verifications: z.array(z.object({
      command: z.string().min(1), status: z.enum(['passed', 'failed', 'skipped']), summary: z.string().min(1).optional(),
    })).max(20),
    artifacts: z.array(z.object({
      type: z.enum(['pull-request', 'branch', 'commit', 'url']), url: z.string().startsWith('https://'), label: z.string().min(1).optional(),
    })).max(20),
    changedFileCount: z.number().int().nonnegative().optional(),
    createdAt: z.iso.datetime(),
  }),
  comment: commentSchema,
  run: runSchema,
})
/** Agent brief, bounded in UTF-8 bytes like the server. */
const briefText = z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= AGENT_SETTINGS_BRIEF_MAX_BYTES)
const settingsSchema: z.ZodType<AgentSettingsRecord> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, revision: z.number().int().nonnegative(),
  leaseMinutes: z.number().int().positive(), allowTakeoverAfterLeaseExpiry: z.boolean(),
  // Servers older than the Ready statuses and briefs omit them.
  readyStatusIds: z.array(identifier).max(AGENT_SETTINGS_MAX_READY_STATUSES).default([]),
  brief: briefText.optional(),
  projectBriefs: z.record(identifier, briefText)
    .refine((briefs) => Object.keys(briefs).length <= AGENT_SETTINGS_MAX_PROJECT_BRIEFS).default({}),
  updatedAt: z.iso.datetime().optional(), updatedBy: z.string().min(1).optional(),
})
const problemSchema = z.object({
  status: z.number().int(), code: z.string(), retryable: z.boolean(),
  errors: z.array(z.object({ code: z.string() })).max(20).optional(),
})
/** Safe guidance for Agent Run fence reasons; remote detail text is never forwarded. */
const reasonMessages: Record<(typeof AGENT_RUN_PROBLEM_REASONS)[number], string> = {
  agent_run_conflict: 'Another agent instance holds this task. Inspect it with get_task and ask the user before continuing; take it over only when the user asks and its run is stalled.',
  agent_run_not_active: 'Your Agent Run is no longer active for this task (finished, released by a person, or taken over by another instance). Stop working on it and report the situation to the user.',
  agent_run_forbidden: 'Only the task assignee can start or operate an Agent Run with this credential. Check MUKUROJI_MCP_ASSIGNEE_ID and the credential owner.',
  invalid_transition: 'The task is not in a state that permits this operation. Reload its current status.',
  agent_run_takeover_disabled: 'This Team does not allow taking over stalled runs. Ask the user to release the run instead.',
  invalid_artifact_url: 'An artifact url is not an https URL without credentials. Nothing was saved; fix the link and report again with a new idempotencyKey.',
  not_ready: 'This task is not in a status the Team marks as ready for agents. Do not start it; pick another task with get_next_task or ask the user.',
}

/** Reads a bounded response while always releasing its stream, including on overflow. */
async function readBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new AgentTaskError('invalid_response', 'The public API returned an empty response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumBytes) throw new AgentTaskError('response_limit', 'API response exceeded the size limit. Reduce the page size or task content.')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}

/** Extracts only allowlisted codes and retry metadata; remote messages and malformed bodies remain private. */
async function readProblem(response: Response) {
  if (![400, 403, 409].includes(response.status) || !response.headers.get('content-type')?.includes('application/problem+json')) {
    await response.body?.cancel()
    return undefined
  }
  try {
    const parsed = problemSchema.safeParse(JSON.parse(await readBody(response, 64 * 1024)))
    if (!parsed.success || parsed.data.status !== response.status) return undefined
    const reason = AGENT_RUN_PROBLEM_REASONS.find((candidate) => parsed.data.errors?.some((error) => error.code === candidate))
    return {
      idempotencyConflict: response.status === 409 && parsed.data.code === 'idempotency_conflict',
      retryable: parsed.data.retryable,
      ...(reason === undefined ? {} : { reason }),
    }
  } catch {
    return undefined
  }
}

/** Creates a validated page schema that rejects missing or contradictory cursors. */
function pageSchema<T>(item: z.ZodType<T>): z.ZodType<AgentPage<T>> {
  return z.object({ items: z.array(item).max(100), hasMore: z.boolean(), nextCursor: z.string().min(1).optional() })
    .refine((page) => page.hasMore === (page.nextCursor !== undefined))
}

/** Trusted operator configuration for the single remote origin used by this process. */
export type AgentApiConfiguration = {
  /** Origin of the Mukuroji deployment, with no path, query, or embedded credentials. */
  origin: string
  /** Scoped API key or OAuth access token; never returned through MCP. */
  token: string
  /** Team fixed for this MCP connection. */
  teamId: string
}

/**
 * Builds an HTTP adapter with a fixed origin, bounded bodies, deadlines, and safe errors.
 * @param config - Validated operator configuration.
 * @param fetcher - HTTP transport, injectable for isolated tests.
 * @returns Canonical Work Item port backed by the versioned public API.
 */
export function createAgentWorkItemApi(
  config: AgentApiConfiguration,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): AgentWorkItemApi {
  const origin = new URL(config.origin)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))) {
    throw new AgentTaskError('configuration', 'MUKUROJI_MCP_URL must be an HTTPS origin; HTTP is allowed only on loopback.')
  }
  if (!config.token || /\s/.test(config.token) || config.token.length > 8192 || !identifier.safeParse(config.teamId).success) {
    throw new AgentTaskError('configuration', 'A valid API token and Team ID are required.')
  }

  /** Sends a bounded public API request without following credential-bearing redirects. */
  async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, key?: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`/api/v1/${path}`, origin)
    url.searchParams.set('teamId', config.teamId)
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    try {
      const response = await fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.token}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const problem = await readProblem(response)
        const retry = response.headers.get('Retry-After')
        const retrySeconds = retry && /^\d{1,6}$/.test(retry) ? Number(retry) : undefined
        if (problem?.reason) {
          throw new AgentTaskError(problem.reason, `Public API returned HTTP ${response.status}. ${reasonMessages[problem.reason]}`)
        }
        const idempotencyRetry = problem?.idempotencyConflict === true && problem.retryable
        const code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' :
          response.status === 404 ? 'not_found' : response.status === 409 ? (problem?.idempotencyConflict ? 'idempotency_conflict' : 'conflict') :
          response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'invalid_request'
        throw new AgentTaskError(code,
          `Public API returned HTTP ${response.status}. ${idempotencyRetry ? 'The original operation is still in progress. Retry only the identical arguments and idempotencyKey.' : code === 'conflict' ? 'Reload the task; for an uncertain previous response retry the identical arguments and idempotencyKey.' : 'Check the credential, task access, and current workflow/field requirements.'}`,
          idempotencyRetry || response.status === 429 || response.status >= 500, retrySeconds)
      }
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
        await response.body?.cancel()
        throw new AgentTaskError('invalid_response', 'The public API did not return JSON.')
      }
      const parsed = schema.safeParse(JSON.parse(await readBody(response, 2 * 1024 * 1024)))
      if (!parsed.success) throw new AgentTaskError('invalid_response', 'The public API response did not match the supported contract.')
      return parsed.data
    } catch (error) {
      if (error instanceof AgentTaskError) throw error
      if (error instanceof SyntaxError) throw new AgentTaskError('invalid_response', 'The public API returned malformed JSON.')
      throw new AgentTaskError('transport', 'The API request failed or timed out. Retry mutations only with identical arguments and the same idempotencyKey.', true)
    }
  }

  /** Checks that a run belongs to the configured Team before exposing it. */
  function scopedRun(run: AgentRunRecord, runId?: string): AgentRunRecord {
    if (run.teamId !== config.teamId || (runId !== undefined && run.runId !== runId)) {
      throw new AgentTaskError('invalid_response', 'The API returned a mismatched run scope.')
    }
    return run
  }

  /** Checks the response scope before exposing a task to the caller. */
  function scoped(task: AgentTask, id?: string): AgentTask {
    if (task.teamId !== config.teamId || (id !== undefined && task.id !== id)) {
      throw new AgentTaskError('invalid_response', 'The API returned a mismatched task scope.')
    }
    return task
  }

  return {
    /** Reads and validates the current Team catalog. */
    async catalog(assignedProjectId) {
      const catalog = await request('work-item-types', catalogSchema, 'GET', undefined, undefined, { assignedProjectId })
      if (catalog.teamId !== config.teamId) throw new AgentTaskError('invalid_response', 'The API returned a mismatched catalog scope.')
      return catalog
    },
    /** Reads one Team-qualified task. */
    async get(id) { return scoped(await request(`work-items/${encodeURIComponent(id)}`, taskSchema), id) },
    /** Retains upstream pagination and validates every returned Team identity. */
    async list(filters, cursor, limit = 50) {
      const page = await request('work-items', pageSchema(taskSchema), 'GET', undefined, undefined, { ...filters, cursor, limit })
      return { ...page, items: page.items.map((item) => scoped(item)) }
    },
    /** Creates a canonical task with the original idempotency key. */
    async create(input, key) { return scoped(await request('work-items', taskSchema, 'POST', { ...input, teamId: config.teamId }, key)) },
    /** Forwards revision, run fence, and idempotency without silently retrying conflicts. */
    async update(id, input, key, fence) { return scoped(await request(`work-items/${encodeURIComponent(id)}`, taskSchema, 'PATCH', { ...input, ...fence }, key), id) },
    /** Reads a bounded canonical discussion page. */
    async comments(id, cursor, limit = 50, assignedProjectId) { return request(`work-items/${encodeURIComponent(id)}/comments`, pageSchema(commentSchema), 'GET', undefined, undefined, { cursor, limit, assignedProjectId }) },
    /** Appends one idempotent progress comment, fenced by the run when one is given. */
    async comment(id, body, key, assignedProjectId, assigneeUserId, fence) { return request(`work-items/${encodeURIComponent(id)}/comments`, commentSchema, 'POST', { body, ...fence }, key, { assignedProjectId, assigneeUserId }) },
    /** Claims a task through the run start endpoint. */
    async startRun(id, input, key) {
      const started = await request(`work-items/${encodeURIComponent(id)}/agent-runs`, z.object({ run: runSchema, workItem: taskSchema }), 'POST', input, key)
      return { run: scopedRun(started.run), task: scoped(started.workItem, id) }
    },
    /** Takes over a stalled run with the original idempotency key. */
    async takeOverRun(id, runId, input, key) {
      const taken = await request(
        `work-items/${encodeURIComponent(id)}/agent-runs/${encodeURIComponent(runId)}/take-over`,
        z.object({ run: runSchema, supersededRun: runSchema }), 'POST', input, key,
      )
      const run = scopedRun(taken.run)
      const supersededRun = scopedRun(taken.supersededRun, runId)
      if (run.workItemId !== id || supersededRun.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned runs for another task.')
      }
      return { run, supersededRun }
    },
    /** Lists one page of active runs. */
    async listActiveRuns(filters, cursor) {
      const page = await request('agent-runs', pageSchema(runSchema), 'GET', undefined, undefined, { state: 'active', ...filters, cursor, limit: 100 })
      return { ...page, items: page.items.map((run) => scopedRun(run)) }
    },
    /** Strongly reads the run that currently claims one task. */
    async claimedRun(id, owner = {}) {
      const page = await request('agent-runs', pageSchema(runSchema), 'GET', undefined, undefined, {
        state: 'active', workItemId: id, assigneeUserId: owner.assigneeUserId, instanceId: owner.instanceId, limit: 1,
      })
      const [run] = page.items.map((item) => scopedRun(item))
      if (run && run.workItemId !== id) throw new AgentTaskError('invalid_response', 'The API returned a run for another task.')
      if (run && owner.assigneeUserId !== undefined && run.assigneeUserId !== owner.assigneeUserId) {
        throw new AgentTaskError('invalid_response', 'The API returned a run of another assignee.')
      }
      return run
    },
    /** Saves a structured report with the original idempotency key. */
    async reportRun(runId, instanceId, input, key, assignedProjectId) {
      const saved = await request(
        `agent-runs/${encodeURIComponent(runId)}/reports`, reportResultSchema, 'POST', { instanceId, ...input }, key, { assignedProjectId },
      )
      if (saved.report.runId !== runId || saved.report.teamId !== config.teamId) {
        throw new AgentTaskError('invalid_response', 'The API returned a report for another run.')
      }
      return { ...saved, run: scopedRun(saved.run, runId) }
    },
    /** Reads one run. */
    async getRun(runId) { return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}`, runSchema), runId) },
    /** Extends a run lease; heartbeats need no idempotency key. */
    async heartbeat(runId, instanceId) {
      return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}/heartbeat`, runSchema, 'POST', { instanceId }), runId)
    },
    /** Closes a run with the original idempotency key. */
    async finishRun(runId, outcome, instanceId, key) {
      return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}/finish`, runSchema, 'POST', { outcome, instanceId }, key), runId)
    },
    /** Reads Team Agent settings. */
    async agentSettings() {
      const settings = await request('agent-settings', settingsSchema)
      if (settings.teamId !== config.teamId) throw new AgentTaskError('invalid_response', 'The API returned mismatched Agent settings.')
      return settings
    },
  }
}
