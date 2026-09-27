import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { composeCodingAgentMcp } from './coding-agent-mcp'

test('real stdio clients discover tools and execute the complete task lifecycle against HTTP', async () => {
  let task = { id: 'task', teamId: 'team', revision: 1, title: 'Implement feature', assigneeUserId: 'agent',
    workflowStatusId: 'todo', statusCategory: 'unstarted', priority: 'medium', dueDate: '',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }
  const notes: { id: string; actorUserId: string; body: string; createdAt: string }[] = []
  const seenKeys: string[] = []
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('Authorization') !== 'Bearer isolated-test-token') return Response.json({}, { status: 401 })
    const url = new URL(request.url)
    if (url.searchParams.get('teamId') !== 'team') return Response.json({}, { status: 400 })
    if (url.pathname === '/api/v1/work-item-types') return Response.json({ teamId: 'team', configurationRevision: 1, workItemTypes: [{
      id: 'default', name: 'Task', customFields: [], workflow: { initialStatusId: 'todo', statuses: [
        { id: 'todo', name: 'Todo', category: 'unstarted', sortOrder: 0 },
        { id: 'coding', name: 'Coding', category: 'started', sortOrder: 1 },
        { id: 'done', name: 'Done', category: 'completed', sortOrder: 2 },
      ] },
    }] })
    if (url.pathname.endsWith('/comments')) {
      if (request.method === 'POST') {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') return Response.json({}, { status: 400 })
        seenKeys.push(request.headers.get('Idempotency-Key') ?? '')
        const note = { id: 'note', actorUserId: 'agent', body: body.body, createdAt: task.updatedAt }
        notes.push(note)
        return Response.json(note, { status: 201 })
      }
      return Response.json({ items: notes, hasMore: false })
    }
    if (request.method === 'PATCH') {
      const body: unknown = await request.json()
      if (!body || typeof body !== 'object' || !('expectedRevision' in body) || body.expectedRevision !== task.revision ||
          !('workflowStatusId' in body) || typeof body.workflowStatusId !== 'string') return Response.json({}, { status: 409 })
      seenKeys.push(request.headers.get('Idempotency-Key') ?? '')
      task = { ...task, revision: task.revision + 1, workflowStatusId: body.workflowStatusId, statusCategory: body.workflowStatusId === 'done' ? 'completed' : 'started' }
      return Response.json(task)
    }
    return Response.json(url.pathname === '/api/v1/work-items' ? { items: [task], hasMore: false } : task)
  } })
  const clients: Client[] = []
  try {
    for (const mode of ['legacy', 'auto'] satisfies ('legacy' | 'auto')[]) {
      const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' }, { versionNegotiation: { mode } })
      clients.push(client)
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, '../../handlers/coding-agent-mcp.ts')],
        env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token',
          MUKUROJI_MCP_TEAM_ID: 'team', MUKUROJI_MCP_ASSIGNEE_ID: 'agent',
          MUKUROJI_MCP_AGENT_NAME: 'test-agent', MUKUROJI_MCP_READ_ONLY: mode === 'auto' ? 'true' : 'false' },
        stderr: 'pipe',
      })
      await client.connect(transport)
      const tools = (await client.listTools()).tools.map((tool) => tool.name)
      expect(tools).toContain('get_next_task')
      expect((await client.readResource({ uri: 'mukuroji://agent/workflow' })).contents).toHaveLength(1)
      expect((await client.getPrompt({ name: 'work-on-next-task', arguments: {} })).messages).toHaveLength(1)
      if (mode === 'auto') {
        expect(tools).not.toContain('start_task')
        expect(tools).not.toContain('report_progress')
        continue
      }
      expect(tools).toHaveLength(14)
      expect((await client.callTool({ name: 'get_next_task', arguments: {} })).structuredContent).toMatchObject({ data: { action: 'start', task: { id: 'task' } } })
      const startKey = crypto.randomUUID()
      expect((await client.callTool({ name: 'start_task', arguments: { taskId: 'task', expectedRevision: 1, workflowStatusId: 'coding', idempotencyKey: startKey } })).isError).not.toBe(true)
      expect((await client.callTool({ name: 'get_work_status', arguments: {} })).structuredContent).toMatchObject({ data: { counts: { started: 1, completed: 0 } } })
      expect((await client.callTool({ name: 'report_progress', arguments: { taskId: 'task', message: 'Tests passed; PR https://example.test/pr/1', idempotencyKey: crypto.randomUUID() } })).isError).not.toBe(true)
      expect((await client.callTool({ name: 'list_progress', arguments: { taskId: 'task' } })).structuredContent).toMatchObject({ data: { items: [{ body: '[test-agent]\n\nTests passed; PR https://example.test/pr/1' }] } })
      expect((await client.callTool({ name: 'complete_task', arguments: { taskId: 'task', expectedRevision: 2, workflowStatusId: 'done', idempotencyKey: crypto.randomUUID() } })).structuredContent).toMatchObject({ data: { statusCategory: 'completed' } })
      expect((await client.callTool({ name: 'get_next_task', arguments: {} })).structuredContent).toMatchObject({ data: { action: 'none', task: null } })
      expect(seenKeys).toHaveLength(3)
      expect(seenKeys[0]).toBe(startKey)
      const invalid = await client.callTool({ name: 'get_task', arguments: { taskId: '..' } })
      expect(invalid.isError).toBe(true)
    }
  } finally {
    for (const client of clients) await client.close()
    await api.stop(true)
  }
}, 30_000)

test('configuration failures never echo supplied secrets', () => {
  expect(() => composeCodingAgentMcp({ MUKUROJI_MCP_TOKEN: 'never-print-this' })).toThrow('Set MUKUROJI_MCP_URL')
  try { composeCodingAgentMcp({ MUKUROJI_MCP_TOKEN: 'never-print-this' }) } catch (error) { expect(String(error)).not.toContain('never-print-this') }
})
