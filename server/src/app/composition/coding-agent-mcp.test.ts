import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { composeCodingAgentMcp, deriveAgentInstanceId } from './coding-agent-mcp'

/** Public run fields kept by the fake API, plus the raw instance ID only the fake sees. */
type FakeRun = {
  /** Public run record. */
  run: Record<string, unknown> & { runId: string; workItemId: string; state: string }
  /** Instance that started the run. */
  instanceId: string
}

/** Source entry point of the stdio server. */
const handlerPath = resolve(import.meta.dir, '../../handlers/coding-agent-mcp.ts')

/**
 * Starts a fake public API that enforces one active run per task, as Mukuroji does.
 *
 * @returns The server and helpers that act as a person in the Web application.
 */
function startFakeApi() {
  let task = { id: 'task', teamId: 'team', revision: 1, title: 'Implement feature', assigneeUserId: 'agent',
    workflowStatusId: 'todo', statusCategory: 'unstarted', priority: 'medium', dueDate: '',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }
  const notes: { id: string; actorUserId: string; body: string; createdAt: string }[] = []
  const commentBodies: Record<string, unknown>[] = []
  const reportBodies: Record<string, unknown>[] = []
  const seenKeys: string[] = []
  const runs: FakeRun[] = []
  /** Builds an Agent Run problem response. */
  const problem = (status: number, reason: string) => new Response(JSON.stringify({
    type: `https://docs.mukuroji.app/problems/${status === 403 ? 'forbidden' : 'conflict'}`, title: 'Conflict', status,
    code: status === 403 ? 'forbidden' : 'conflict', requestId: 'request', retryable: false,
    errors: [{ pointer: '/agentInstanceId', code: reason, message: 'Held' }],
  }), { status, headers: { 'Content-Type': 'application/problem+json' } })
  /** Rejects a fenced mutation that does not hold the task's active run. */
  const fence = (body: Record<string, unknown>) => {
    const holder = runs.find((entry) => entry.run.workItemId === 'task' && entry.run.state === 'active')
    if (typeof body.agentRunId === 'string') {
      const own = runs.find((entry) => entry.run.runId === body.agentRunId)
      if (!own || own.run.state !== 'active' || own.instanceId !== body.agentInstanceId) return problem(409, 'agent_run_not_active')
    } else if (holder && body.agentInstanceId !== undefined && holder.instanceId !== body.agentInstanceId) {
      return problem(409, 'agent_run_conflict')
    }
    return undefined
  }
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
    if (url.pathname === '/api/v1/agent-settings') {
      return Response.json({ schemaVersion: 1, teamId: 'team', revision: 1, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false })
    }
    if (url.pathname === '/api/v1/agent-context') {
      return Response.json({
        schemaVersion: 1, teamId: 'team', revision: 1, readyStatusIds: [], brief: 'Run bun test.', projectBriefs: { web: 'Add a story.' },
      })
    }
    if (url.pathname === '/api/v1/agent-runs') {
      const instanceId = url.searchParams.get('instanceId')
      return Response.json({ items: runs.filter((entry) => entry.run.state === 'active' && (!instanceId || entry.instanceId === instanceId)).map((entry) => entry.run), hasMore: false })
    }
    const runMatch = /^\/api\/v1\/agent-runs\/([^/]+)(?:\/(finish|heartbeat|reports))?$/u.exec(url.pathname)
    if (runMatch) {
      const entry = runs.find((candidate) => candidate.run.runId === runMatch[1])
      if (!entry) return Response.json({}, { status: 404 })
      if (runMatch[2] !== undefined) {
        const body: unknown = await request.json()
        if (entry.run.state !== 'active') return problem(409, 'agent_run_not_active')
        if (!body || typeof body !== 'object' || !('instanceId' in body) || body.instanceId !== entry.instanceId) {
          return problem(409, 'agent_run_conflict')
        }
        if (runMatch[2] === 'heartbeat') return Response.json(entry.run)
        if (runMatch[2] === 'reports') {
          const { instanceId: _instanceId, ...report } = { ...body }
          reportBodies.push(report)
          entry.run = { ...entry.run, reportCount: Number(entry.run.reportCount) + 1 }
          const message = 'message' in body && typeof body.message === 'string' ? body.message : ''
          return Response.json({
            report: {
              schemaVersion: 1, runId: entry.run.runId, teamId: 'team', workItemId: 'task', sequence: entry.run.reportCount,
              kind: 'kind' in body && typeof body.kind === 'string' ? body.kind : 'progress', commentId: 'note',
              verifications: 'verifications' in body ? body.verifications : [], artifacts: 'artifacts' in body ? body.artifacts : [],
              createdAt: task.updatedAt,
            },
            comment: { id: 'note', actorUserId: 'agent', body: `[${String(entry.run.agentName)}]\n\n${message}`, createdAt: task.updatedAt },
            run: entry.run,
          }, { status: 201 })
        }
        seenKeys.push(request.headers.get('Idempotency-Key') ?? '')
        entry.run = { ...entry.run, state: 'finished', outcome: body && typeof body === 'object' && 'outcome' in body ? body.outcome : 'completed', finishedAt: task.updatedAt, finishedBy: 'agent' }
      }
      return Response.json(entry.run)
    }
    if (url.pathname === '/api/v1/work-items/task/agent-runs') {
      if (request.method !== 'POST') return Response.json({ items: [...runs].reverse().map((entry) => entry.run), hasMore: false })
      const body: unknown = await request.json()
      if (!body || typeof body !== 'object' || !('instanceId' in body) || typeof body.instanceId !== 'string' ||
          !('expectedRevision' in body) || !('workflowStatusId' in body) || typeof body.workflowStatusId !== 'string') return Response.json({}, { status: 400 })
      if (runs.some((entry) => entry.run.workItemId === 'task' && entry.run.state === 'active')) return problem(409, 'agent_run_conflict')
      if (body.expectedRevision !== task.revision || task.statusCategory !== 'unstarted') return problem(409, 'invalid_transition')
      seenKeys.push(request.headers.get('Idempotency-Key') ?? '')
      task = { ...task, revision: task.revision + 1, workflowStatusId: body.workflowStatusId, statusCategory: 'started' }
      const run = { schemaVersion: 1, runId: `run_00000000-0000-4000-8000-${String(runs.length + 1).padStart(12, '0')}`, teamId: 'team',
        workItemId: 'task', assigneeUserId: 'agent', runtime: 'runtime' in body && typeof body.runtime === 'string' ? body.runtime : 'other',
        agentName: 'agentName' in body && typeof body.agentName === 'string' ? body.agentName : 'agent', state: 'active', startRevision: task.revision,
        leaseMinutes: 30, startedAt: task.updatedAt, lastHeartbeatAt: task.updatedAt, leaseExpiresAt: '2026-09-01T00:30:00.000Z', stalled: false, reportCount: 0 }
      runs.push({ run, instanceId: body.instanceId })
      return Response.json({ run, workItem: task }, { status: 201 })
    }
    if (url.pathname.endsWith('/comments')) {
      if (request.method === 'POST') {
        const body: unknown = await request.json()
        if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') return Response.json({}, { status: 400 })
        const rejected = fence({ ...body })
        if (rejected) return rejected
        commentBodies.push({ ...body })
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
      const rejected = fence({ ...body })
      if (rejected) return rejected
      seenKeys.push(request.headers.get('Idempotency-Key') ?? '')
      task = { ...task, revision: task.revision + 1, workflowStatusId: body.workflowStatusId, statusCategory: body.workflowStatusId === 'done' ? 'completed' : 'started' }
      return Response.json(task)
    }
    return Response.json(url.pathname === '/api/v1/work-items' ? { items: [task], hasMore: false } : task)
  } })
  return {
    api,
    commentBodies,
    reportBodies,
    seenKeys,
    /** Releases the active run and moves the task back to Todo, as a person would. */
    releaseAndReopen() {
      for (const entry of runs) {
        if (entry.run.state === 'active') entry.run = { ...entry.run, state: 'finished', outcome: 'released', finishedAt: task.updatedAt, finishedBy: 'member' }
      }
      task = { ...task, revision: task.revision + 1, workflowStatusId: 'todo', statusCategory: 'unstarted' }
    },
  }
}

/**
 * Connects an MCP client to a fresh stdio server process.
 *
 * @param port - Fake API port assigned by Bun.
 * @param mode - Protocol negotiation mode.
 * @param extra - Additional environment variables.
 * @param entry - Script the server process runs; the source handler by default.
 * @param command - Runtime that runs the script; Bun by default.
 * @returns Connected client.
 */
async function connect(
  port: number | undefined,
  mode: 'legacy' | 'auto',
  extra: Record<string, string>,
  entry = handlerPath,
  command = process.execPath,
): Promise<Client> {
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' }, { versionNegotiation: { mode } })
  const transport = new StdioClientTransport({
    command,
    args: [entry],
    env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token',
      MUKUROJI_MCP_TEAM_ID: 'team', MUKUROJI_MCP_ASSIGNEE_ID: 'agent', MUKUROJI_MCP_AGENT_NAME: 'test-agent', ...extra },
    stderr: 'pipe',
  })
  await client.connect(transport)
  return client
}

/**
 * Calls a tool and returns its structured content.
 *
 * @param client - Connected client.
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The structured result and whether it is an error.
 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args })
  return { isError: response.isError === true, content: response.structuredContent }
}

test('real stdio clients discover tools and run the task lifecycle with an Agent Run against HTTP', async () => {
  const fake = startFakeApi()
  const clients: Client[] = []
  try {
    const readOnly = await connect(fake.api.port, 'auto', { MUKUROJI_MCP_READ_ONLY: 'true' })
    clients.push(readOnly)
    const readTools = (await readOnly.listTools()).tools.map((tool) => tool.name)
    expect(readTools).toContain('get_next_task')
    for (const name of ['start_task', 'report_progress', 'heartbeat', 'finish_run', 'take_over_task']) expect(readTools).not.toContain(name)
    expect((await readOnly.readResource({ uri: 'mukuroji://agent/workflow' })).contents).toHaveLength(1)
    expect((await readOnly.readResource({ uri: 'mukuroji://project/web/brief' })).contents)
      .toMatchObject([{ mimeType: 'text/markdown', text: 'Run bun test.\n\nAdd a story.' }])
    expect((await readOnly.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate))
      .toContain('mukuroji://project/{projectId}/brief')
    expect((await readOnly.getPrompt({ name: 'work-on-next-task', arguments: {} })).messages).toHaveLength(1)

    const client = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    clients.push(client)
    expect((await client.listTools()).tools).toHaveLength(17)
    expect((await call(client, 'get_configuration')).content).toMatchObject({ data: {
      runtime: 'claude-code', agentSettings: { leaseMinutes: 30, readyStatusIds: [] }, brief: 'Run bun test.',
    } })
    expect((await call(client, 'get_next_task')).content).toMatchObject({ data: { action: 'start', task: { id: 'task' }, ownRuns: [] } })
    const startKey = crypto.randomUUID()
    const started = await call(client, 'start_task', { taskId: 'task', expectedRevision: 1, workflowStatusId: 'coding', idempotencyKey: startKey })
    expect(started).toMatchObject({ isError: false, content: { data: { task: { statusCategory: 'started' }, run: { runtime: 'claude-code', state: 'active' } } } })
    expect((await call(client, 'get_next_task')).content).toMatchObject({ data: { action: 'in_progress', task: { id: 'task' } } })
    const reported = await call(client, 'report_progress', {
      taskId: 'task', message: 'Tests passed', kind: 'verification',
      verifications: [{ command: 'bun test', status: 'passed' }],
      artifacts: [{ type: 'pull-request', url: 'https://example.test/pr/1', label: 'PR 1' }],
      idempotencyKey: crypto.randomUUID(),
    })
    expect(reported).toMatchObject({ isError: false, content: { data: { report: { kind: 'verification', sequence: 1 }, comment: { id: 'note' } } } })
    expect(fake.reportBodies.at(-1)).toEqual({
      kind: 'verification', message: 'Tests passed', verifications: [{ command: 'bun test', status: 'passed' }],
      artifacts: [{ type: 'pull-request', url: 'https://example.test/pr/1', label: 'PR 1' }],
    })
    expect(fake.commentBodies).toEqual([])
    // Values the report endpoint always rejects fail at the tool boundary and never reach the API.
    const reportsBeforeInvalid = fake.reportBodies.length
    for (const invalid of [
      { message: 'Link', artifacts: [{ type: 'url', url: 'http://example.test' }] },
      { message: 'Link', artifacts: [{ type: 'url', url: 'https://user:pass@example.test/log' }] },
      { message: 'Link', artifacts: [{ type: 'url', url: 'https://example.test/log?token=x' }] },
      { message: 'Link', artifacts: [{ type: 'url', url: 'https://example.test:99999/log' }] },
      { message: 'Ran', verifications: [{ command: 'bun\ntest', status: 'passed' }] },
      { message: 'Bell\u0007' },
    ]) {
      expect((await call(client, 'report_progress', { taskId: 'task', ...invalid, idempotencyKey: crypto.randomUUID() })).isError).toBe(true)
    }
    expect(fake.reportBodies).toHaveLength(reportsBeforeInvalid)
    expect((await call(client, 'complete_task', { taskId: 'task', expectedRevision: 2, workflowStatusId: 'done', idempotencyKey: crypto.randomUUID() })).content)
      .toMatchObject({ data: { statusCategory: 'completed' } })
    expect((await call(client, 'finish_run', { runId: 'run_00000000-0000-4000-8000-000000000001', outcome: 'completed', idempotencyKey: crypto.randomUUID() })).content)
      .toMatchObject({ data: { state: 'finished', outcome: 'completed' } })
    expect((await call(client, 'get_next_task')).content).toMatchObject({ data: { action: 'none', task: null, ownRuns: [] } })
    expect(fake.seenKeys[0]).toBe(startKey)
    expect((await call(client, 'get_task', { taskId: '..' })).isError).toBe(true)
  } finally {
    for (const client of clients) await client.close()
    await fake.api.stop(true)
  }
}, 30_000)

test('two instances of one member never share a claim, and a release lets the other start', async () => {
  const fake = startFakeApi()
  const clients: Client[] = []
  try {
    const first = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    const second = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'codex', MUKUROJI_MCP_INSTANCE_ID: 'instance-b' })
    clients.push(first, second)
    expect((await call(first, 'start_task', { taskId: 'task', expectedRevision: 1, workflowStatusId: 'coding', idempotencyKey: crypto.randomUUID() })).isError).toBe(false)

    const conflict = await call(second, 'start_task', { taskId: 'task', expectedRevision: 2, workflowStatusId: 'coding', idempotencyKey: crypto.randomUUID() })
    expect(conflict).toMatchObject({ isError: true, content: { error: { code: 'agent_run_conflict' } } })
    const next = await call(second, 'get_next_task')
    expect(next.content).toMatchObject({ data: { action: 'none', ownRuns: [], otherRuns: [{ workItemId: 'task', runtime: 'claude-code' }] } })
    expect(JSON.stringify(next.content)).not.toContain('instance-a')
    expect((await call(second, 'report_progress', { taskId: 'task', message: 'Not mine', idempotencyKey: crypto.randomUUID() })).content)
      .toMatchObject({ error: { code: 'agent_run_conflict' } })

    fake.releaseAndReopen()
    expect((await call(second, 'get_next_task')).content).toMatchObject({ data: { action: 'start', task: { id: 'task' }, otherRuns: [] } })
    expect((await call(second, 'start_task', { taskId: 'task', expectedRevision: 3, workflowStatusId: 'coding', idempotencyKey: crypto.randomUUID() })).content)
      .toMatchObject({ data: { run: { runtime: 'codex' } } })
    expect((await call(first, 'get_next_task')).content).toMatchObject({ data: { action: 'none', ownRuns: [], otherRuns: [{ runtime: 'codex' }] } })
  } finally {
    for (const client of clients) await client.close()
    await fake.api.stop(true)
  }
}, 30_000)

test('the distributable Node bundle serves the same tools over stdio', async () => {
  // Runs the script behind `bun run mcp:build`, which produces the distributable bundle.
  const outdir = await mkdtemp(join(tmpdir(), 'mukuroji-mcp-bundle-'))
  const fake = startFakeApi()
  let client: Client | undefined
  try {
    const build = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../../../scripts/build-coding-agent-mcp.ts'), '--outdir', outdir], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(await build.exited).toBe(0)
    // Every inlined package's license ships with the bundle.
    const notices = await Bun.file(join(outdir, 'mcp.mjs.LICENSES.txt')).text()
    expect(notices).toContain('@modelcontextprotocol/server@')
    expect(notices).toContain('zod@')
    // The bundle is published for Node, so only a Node run proves it; Bun would hide Node regressions.
    const node = Bun.which('node')
    if (!node) throw new Error('Node.js is required to test the distributable MCP bundle.')
    client = await connect(fake.api.port, 'auto', { MUKUROJI_MCP_RUNTIME: 'codex' }, join(outdir, 'mcp.mjs'), node)
    expect((await client.listTools()).tools).toHaveLength(17)
    expect((await call(client, 'get_configuration')).content).toMatchObject({ data: { runtime: 'codex' } })
  } finally {
    await client?.close()
    await fake.api.stop(true)
    await rm(outdir, { recursive: true, force: true })
  }
}, 30_000)

test('derives a stable instance ID without exposing host or account names', () => {
  const derived = deriveAgentInstanceId('codex', 'agent')
  expect(derived).toMatch(/^[0-9a-f]{64}$/u)
  expect(deriveAgentInstanceId('codex', 'agent')).toBe(derived)
  expect(deriveAgentInstanceId('kiro', 'agent')).not.toBe(derived)
})

test('configuration failures never echo supplied secrets', () => {
  expect(() => composeCodingAgentMcp({ MUKUROJI_MCP_TOKEN: 'never-print-this' })).toThrow('Set MUKUROJI_MCP_URL')
  try { composeCodingAgentMcp({ MUKUROJI_MCP_TOKEN: 'never-print-this' }) } catch (error) { expect(String(error)).not.toContain('never-print-this') }
  expect(() => composeCodingAgentMcp({
    MUKUROJI_MCP_URL: 'http://127.0.0.1:3000', MUKUROJI_MCP_TOKEN: 'token', MUKUROJI_MCP_TEAM_ID: 'team',
    MUKUROJI_MCP_ASSIGNEE_ID: 'agent', MUKUROJI_MCP_RUNTIME: 'cursor',
  })).toThrow('RUNTIME')
})
