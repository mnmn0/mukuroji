import { expect, test } from 'bun:test'
import { createAgentWorkItemApi } from './work-item-api'
import { createAgentTasks } from '../../application/agent-tasks'

const config = { origin: 'https://mukuroji.example.test', token: 'secret-test-token', teamId: 'team' }
const validTask = { id: 'task', teamId: 'team', revision: 1, title: 'Task', assigneeUserId: 'agent',
  workflowStatusId: 'todo', statusCategory: 'unstarted', priority: 'medium', dueDate: '',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }

test('pins origin and Team, encodes IDs, forwards idempotency unchanged, and refuses redirects', async () => {
  const seen: { url: URL; init: RequestInit }[] = []
  const api = createAgentWorkItemApi(config, async (url, init) => {
    seen.push({ url, init })
    return Response.json({ ...validTask, id: 'task/with?query' })
  })
  await api.update('task/with?query', { expectedRevision: 1, workflowStatusId: 'coding' }, 'same-key')
  expect(seen[0].url.href).toBe('https://mukuroji.example.test/api/v1/work-items/task%2Fwith%3Fquery?teamId=team')
  expect(seen[0].init.redirect).toBe('error')
  const headers = new Headers(seen[0].init.headers)
  expect(headers.get('Authorization')).toBe('Bearer secret-test-token')
  expect(headers.get('Idempotency-Key')).toBe('same-key')
})

test('rejects insecure remote origins and embedded credentials, but allows local development', () => {
  for (const origin of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?token=secret', 'file:///tmp/data']) {
    expect(() => createAgentWorkItemApi({ ...config, origin })).toThrow()
  }
  expect(() => createAgentWorkItemApi({ ...config, origin: 'http://127.0.0.1:3000' })).not.toThrow()
})

test('redacts upstream error bodies and preserves rate-limit recovery information', async () => {
  const api = createAgentWorkItemApi(config, async () => new Response('secret-test-token raw upstream error', { status: 429, headers: { 'Retry-After': '60' } }))
  await expect(api.get('task')).rejects.toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: 60 })
  try { await api.get('task') } catch (error) { expect(String(error)).not.toContain('secret-test-token') }
  const broken = createAgentWorkItemApi(config, async () => { throw new Error('secret-test-token') })
  await expect(broken.get('task')).rejects.toMatchObject({ code: 'transport', retryable: true })
})

test('validates JSON, task scope, pagination, and response size before exposing content', async () => {
  for (const value of [{ ...validTask, teamId: 'other' }, { ...validTask, id: 'other' }, { ...validTask, revision: -1 }]) {
    const api = createAgentWorkItemApi(config, async () => Response.json(value))
    await expect(api.get('task')).rejects.toMatchObject({ code: 'invalid_response' })
  }
  const page = createAgentWorkItemApi(config, async () => Response.json({ items: [], hasMore: true }))
  await expect(page.list({})).rejects.toMatchObject({ code: 'invalid_response' })
  const malformed = createAgentWorkItemApi(config, async () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }))
  await expect(malformed.get('task')).rejects.toMatchObject({ code: 'invalid_response' })
  const huge = createAgentWorkItemApi(config, async () => Response.json({ ...validTask, description: 'x'.repeat(2 * 1024 * 1024) }))
  await expect(huge.get('task')).rejects.toMatchObject({ code: 'response_limit' })
})

test('preserves only bounded allowlisted idempotency retry metadata', async () => {
  for (const retryable of [true, false]) {
    const api = createAgentWorkItemApi(config, async () => Response.json({
      status: 409, code: 'idempotency_conflict', retryable, detail: 'secret-test-token',
    }, { status: 409, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '5' } }))
    await expect(api.update('task', { expectedRevision: 1, title: 'New' }, 'same-key')).rejects.toMatchObject({
      code: 'idempotency_conflict', retryable, retryAfterSeconds: 5,
    })
    try { await api.get('task') } catch (error) { expect(String(error)).not.toContain('secret-test-token') }
  }
  for (const body of ['{bad', JSON.stringify({ code: 'conflict', status: 409, retryable: true }), JSON.stringify({ status: 409, code: 'idempotency_conflict', retryable: true, detail: 's'.repeat(70_000) })]) {
    const api = createAgentWorkItemApi(config, async () => new Response(body, { status: 409, headers: { 'Content-Type': 'application/problem+json' } }))
    await expect(api.get('task')).rejects.toMatchObject({ code: 'conflict', retryable: false })
  }
})

test('carries configured Project and assignee fences on comment requests', async () => {
  const api = createAgentWorkItemApi(config, async (url, init) => {
    expect(url.searchParams.get('assignedProjectId')).toBe('project')
    if (init.method === 'GET') return Response.json({ items: [], hasMore: false })
    expect(url.searchParams.get('assigneeUserId')).toBe('agent')
    return Response.json({ id: 'note', actorUserId: 'agent', body: 'Progress', createdAt: validTask.createdAt })
  })
  await api.comments('task', undefined, 10, 'project')
  await api.comment('task', 'Progress', 'key', 'project', 'agent')
})

test('restarts oversized queue scans with smaller cursor-bound pages and preserves complete status and selection', async () => {
  const rows = Array.from({ length: 71 }, (_, index) => ({ ...validTask, id: String(index),
    description: index < 50 ? '' : '\u0001'.repeat(100_000),
    priority: index === 70 ? 'high' : 'medium',
  }))
  const starts: number[] = []
  const api = createAgentWorkItemApi(config, async (url) => {
    const limit = Number(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')
    if (!cursor) starts.push(limit)
    const [cursorLimit, offset] = cursor ? cursor.split(':').map(Number) : [limit, 0]
    expect(cursorLimit).toBe(limit)
    const next = offset + limit
    return Response.json({ items: rows.slice(offset, next), hasMore: next < rows.length,
      ...(next < rows.length ? { nextCursor: `${limit}:${next}` } : {}),
    })
  })
  const service = createAgentTasks(api, { agentName: 'test', assigneeUserId: 'agent' })
  expect(await service.status({})).toMatchObject({ total: 71, counts: { unstarted: 71 } })
  expect(await service.next({})).toMatchObject({ action: 'start', task: { id: '70' } })
  expect(starts).toEqual([50, 10, 2, 50, 10, 2])
})
