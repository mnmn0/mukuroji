import { z } from 'zod'
import type { AgentCatalog, AgentPage, AgentTask, AgentWorkItemApi } from '../../application/work-item-api'
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
        await response.body?.cancel()
        const retry = response.headers.get('Retry-After')
        const retrySeconds = retry && /^\d{1,6}$/.test(retry) ? Number(retry) : undefined
        const code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' :
          response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' :
          response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'invalid_request'
        throw new AgentTaskError(code,
          `Public API returned HTTP ${response.status}. ${code === 'conflict' ? 'Reload the task; for an uncertain previous response retry the identical arguments and idempotencyKey.' : 'Check the credential, task access, and current workflow/field requirements.'}`,
          response.status === 429 || response.status >= 500, retrySeconds)
      }
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
        await response.body?.cancel()
        throw new AgentTaskError('invalid_response', 'The public API did not return JSON.')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 2 * 1024 * 1024) {
            throw new AgentTaskError('response_limit', 'API response exceeded 2 MiB. Reduce the page size or task content.')
          }
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
      if (!parsed.success) throw new AgentTaskError('invalid_response', 'The public API response did not match the supported contract.')
      return parsed.data
    } catch (error) {
      if (error instanceof AgentTaskError) throw error
      if (error instanceof SyntaxError) throw new AgentTaskError('invalid_response', 'The public API returned malformed JSON.')
      throw new AgentTaskError('transport', 'The API request failed or timed out. Retry mutations only with identical arguments and the same idempotencyKey.', true)
    }
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
    async catalog() {
      const catalog = await request('work-item-types', catalogSchema)
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
    /** Forwards revision and idempotency without silently retrying conflicts. */
    async update(id, input, key) { return scoped(await request(`work-items/${encodeURIComponent(id)}`, taskSchema, 'PATCH', input, key), id) },
    /** Reads a bounded canonical discussion page. */
    async comments(id, cursor, limit = 50) { return request(`work-items/${encodeURIComponent(id)}/comments`, pageSchema(commentSchema), 'GET', undefined, undefined, { cursor, limit }) },
    /** Appends one idempotent progress comment. */
    async comment(id, body, key) { return request(`work-items/${encodeURIComponent(id)}/comments`, commentSchema, 'POST', { body }, key) },
  }
}
