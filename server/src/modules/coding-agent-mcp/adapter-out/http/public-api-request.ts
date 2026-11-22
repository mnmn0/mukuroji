import { z } from 'zod'
import { AGENT_RUN_PROBLEM_REASONS } from '@mukuroji/contracts'
import type { AgentPage } from '../../application/work-item-api'
import { AgentTaskError } from '../../application/work-item-api'

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
  not_resumable: 'This task is not in a status the Team allows agents to resume from (agentSettings.resumableStatusIds in get_configuration). Do not continue it; ask the user.',
  not_ready: 'This task is not ready for agents: it is not in a Ready status, or the Team requires acceptance criteria and the task has none (check get_task and the agentSettings acceptance criteria field in get_configuration). Do not start it; pick another task with get_next_task or ask the user.',
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
export function pageSchema<T>(item: z.ZodType<T>): z.ZodType<AgentPage<T>> {
  return z.object({ items: z.array(item).max(100), hasMore: z.boolean(), nextCursor: z.string().min(1).optional() })
    .refine((page) => page.hasMore === (page.nextCursor !== undefined))
}

/** Connection to the single trusted Mukuroji origin used by this process. */
export type PublicApiConnection = {
  /** Origin of the Mukuroji deployment, with no path, query, or embedded credentials. */
  origin: string
  /** Scoped API key or OAuth access token; never returned through MCP. */
  token: string
  /** Team sent as the `teamId` query of every request; omitted for Workspace-wide connections. */
  teamId?: string
}

/** Sends one validated public API request and returns its parsed body. */
export type PublicApiRequest = <T>(
  path: string,
  schema: z.ZodType<T>,
  method?: string,
  body?: unknown,
  key?: string,
  query?: Record<string, string | number | undefined>,
) => Promise<T>

/**
 * Builds a bounded public API requester with a fixed origin, deadlines, and safe errors.
 * @param config - Validated operator configuration.
 * @param fetcher - HTTP transport, injectable for isolated tests.
 * @returns A function that sends one request under `/api/v1/`.
 */
export function createPublicApiRequest(
  config: PublicApiConnection,
  fetcher: (url: URL, init: RequestInit) => Promise<Response>,
): PublicApiRequest {
  const origin = new URL(config.origin)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))) {
    throw new AgentTaskError('configuration', 'MUKUROJI_MCP_URL must be an HTTPS origin; HTTP is allowed only on loopback.')
  }
  if (!config.token || /\s/.test(config.token) || config.token.length > 8192) {
    throw new AgentTaskError('configuration', 'A valid API token is required.')
  }

  /** Sends a bounded public API request without following credential-bearing redirects. */
  return async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, key?: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`/api/v1/${path}`, origin)
    if (config.teamId !== undefined) url.searchParams.set('teamId', config.teamId)
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
}
