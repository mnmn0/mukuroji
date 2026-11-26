import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CODING_AGENT_MCP_VERSION } from '../../modules/coding-agent-mcp/application/compatibility'
import { AgentTaskError } from '../../modules/coding-agent-mcp/application/work-item-api'
import { composeCodingAgentMcp, deriveAgentInstanceId, readTeamIds } from './coding-agent-mcp'

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
    schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }
  const notes: { id: string; actorUserId: string; body: string; createdAt: string }[] = []
  const commentBodies: Record<string, unknown>[] = []
  const reportBodies: Record<string, unknown>[] = []
  const createBodies: Record<string, unknown>[] = []
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
    // Liveness is public, so the MCP must read it without the API credential.
    if (new URL(request.url).pathname === '/api/health') {
      if (request.headers.get('Authorization') !== null) return Response.json({}, { status: 400 })
      return Response.json({ ok: true, status: 'alive', codingAgentMcp: { apiRevision: 8, minimumApiRevision: 1 } })
    }
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
    if (url.pathname === '/api/v1/work-item-templates') return Response.json({ teamId: 'team', templates: [{
      id: 'release-check', version: 2, name: 'Release check', title: 'Release', priority: 'high', acceptanceCriteria: ['Tests pass'],
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
    if (url.pathname === '/api/v1/work-items/task/attachments') {
      return Response.json({ items: [{ id: 'file-1', name: 'spec.pdf', versionId: 'version-1', versionNumber: 1, contentType: 'application/pdf', sizeBytes: 10, updatedAt: '2026-09-01T00:00:00.000Z' }] })
    }
    if (url.pathname === '/api/v1/work-items/task/attachments/file-1/download') {
      return Response.json({ fileId: 'file-1', versionId: 'version-1', url: 'https://files.example.test/file-1', expiresAt: '2026-09-01T00:05:00.000Z' })
    }
    if (url.pathname === '/api/v1/work-items/task/documents') return Response.json({ items: [{ id: 'spec', title: 'Spec' }], hasMore: false })
    if (url.pathname === '/api/v1/work-items/task/documents/spec') {
      return Response.json({
        schemaVersion: 1, id: 'spec', kind: 'page', title: 'Spec', revision: 1, updatedAt: task.updatedAt, format: 'markdown', content: '# Spec',
      })
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
    if (url.pathname === '/api/v1/work-items' && request.method === 'POST') {
      const body: unknown = await request.json()
      if (!body || typeof body !== 'object') return Response.json({}, { status: 400 })
      createBodies.push({ ...body })
      return Response.json({ ...task, id: 'created', revision: 1 }, { status: 201 })
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
    createBodies,
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
    expect(readTools).toEqual(expect.arrayContaining(['list_task_documents', 'read_document', 'list_task_attachments', 'get_attachment_download_url']))
    for (const name of ['start_task', 'report_progress', 'heartbeat', 'finish_run', 'take_over_task', 'resume_task']) expect(readTools).not.toContain(name)
    expect((await readOnly.readResource({ uri: 'mukuroji://agent/workflow' })).contents).toHaveLength(1)
    expect((await readOnly.readResource({ uri: 'mukuroji://project/web/brief' })).contents)
      .toMatchObject([{ mimeType: 'text/markdown', text: 'Run bun test.\n\nAdd a story.' }])
    expect((await readOnly.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate))
      .toContain('mukuroji://project/{projectId}/brief')
    expect((await readOnly.getPrompt({ name: 'work-on-next-task', arguments: {} })).messages).toHaveLength(1)
    expect((await call(readOnly, 'list_task_documents', { taskId: 'task' })).content)
      .toMatchObject({ data: { items: [{ id: 'spec', title: 'Spec' }], hasMore: false } })
    expect((await call(readOnly, 'read_document', { taskId: 'task', documentId: 'spec' })).content)
      .toMatchObject({ data: { id: 'spec', format: 'markdown', content: '# Spec' } })
    expect((await call(readOnly, 'list_task_attachments', { taskId: 'task' })).content)
      .toMatchObject({ data: { items: [{ id: 'file-1', name: 'spec.pdf' }] } })
    expect((await call(readOnly, 'get_attachment_download_url', { taskId: 'task', fileId: 'file-1' })).content)
      .toMatchObject({ data: { fileId: 'file-1', url: 'https://files.example.test/file-1' } })

    const client = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    clients.push(client)
    expect((await client.listTools()).tools).toHaveLength(22)
    expect((await call(client, 'get_configuration')).content).toMatchObject({ data: {
      runtime: 'claude-code', agentSettings: { leaseMinutes: 30, readyStatusIds: [] }, brief: 'Run bun test.',
      mcp: { version: CODING_AGENT_MCP_VERSION, apiRevision: 8, serverCompatibility: { status: 'compatible', server: { apiRevision: 8, minimumApiRevision: 1 } } },
    } })
    expect(client.getServerVersion()).toMatchObject({ name: 'mukuroji-tasks', version: CODING_AGENT_MCP_VERSION })
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

test('the hook heartbeat renews only the runs of the same instance and always exits 0', async () => {
  const fake = startFakeApi()
  const stampDirectory = await mkdtemp(join(tmpdir(), 'mukuroji-heartbeat-test-'))
  let client: Client | undefined
  /**
   * Runs the handler in heartbeat mode.
   *
   * @param extra - Environment of the hook.
   * @returns Exit code and stderr.
   */
  const heartbeat = async (extra: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, handlerPath, '--heartbeat'], {
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token',
        MUKUROJI_MCP_TEAM_ID: 'team', MUKUROJI_MCP_ASSIGNEE_ID: 'agent', XDG_CACHE_HOME: stampDirectory, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stderr, stdout] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
    return { exitCode, stderr, stdout }
  }
  try {
    client = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    expect((await call(client, 'start_task', { taskId: 'task', expectedRevision: 1, workflowStatusId: 'coding', idempotencyKey: crypto.randomUUID() })).isError).toBe(false)

    expect(await heartbeat({ MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' }))
      .toEqual({ exitCode: 0, stdout: '', stderr: 'mukuroji heartbeat: 1 renewed, 0 recent, 0 failed\n' })
    // A hook that fires again within a minute does not call the API.
    expect((await heartbeat({ MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })).stderr)
      .toBe('mukuroji heartbeat: skipped, renewed within the last minute\n')
    expect((await heartbeat({ MUKUROJI_MCP_RUNTIME: 'codex', MUKUROJI_MCP_INSTANCE_ID: 'instance-b' })).stderr)
      .toBe('mukuroji heartbeat: 0 renewed, 0 recent, 0 failed\n')
    // A Project restriction keeps the hook to the runs the MCP server itself would act on.
    expect((await heartbeat({ MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a',
      MUKUROJI_MCP_PROJECT_ID: 'other-project' })).stderr)
      .toBe('mukuroji heartbeat: 0 renewed, 0 recent, 0 failed\n')
    // Each scope keeps its own stamp: the scoped hook above called the API although the unscoped one had
    // just succeeded, and only its own next call is skipped.
    expect((await heartbeat({ MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a',
      MUKUROJI_MCP_PROJECT_ID: 'other-project' })).stderr)
      .toBe('mukuroji heartbeat: skipped, renewed within the last minute\n')
    // Missing configuration is reported, and the hook still exits 0.
    expect(await heartbeat({ MUKUROJI_MCP_ASSIGNEE_ID: '' })).toMatchObject({ exitCode: 0, stderr: expect.stringContaining('MUKUROJI_MCP_') })
  } finally {
    await client?.close()
    await fake.api.stop(true)
    await rm(stampDirectory, { recursive: true, force: true })
  }
}, 30_000)

test('create_task leaves the schedule to the server so the Workspace working calendar applies', async () => {
  const fake = startFakeApi()
  let client: Client | undefined
  try {
    client = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    for (const dueDate of ['2026-12-01', undefined]) {
      const created = await call(client, 'create_task', {
        title: 'Follow-up', idempotencyKey: crypto.randomUUID(), ...(dueDate ? { dueDate } : {}),
      })
      expect(created.isError).toBe(false)
    }

    expect(fake.createBodies).toHaveLength(2)
    expect(fake.createBodies[0]).toMatchObject({ dueDate: '2026-12-01', assigneeUserId: 'agent', teamId: 'team' })
    for (const body of fake.createBodies) expect(body).not.toHaveProperty('schedule')
    expect(fake.createBodies[1]).not.toHaveProperty('dueDate')
  } finally {
    await client?.close()
    await fake.api.stop(true)
  }
}, 30_000)

test('create_task sends a template and leaves its priority to the server unless one is given', async () => {
  const fake = startFakeApi()
  let client: Client | undefined
  try {
    client = await connect(fake.api.port, 'legacy', { MUKUROJI_MCP_RUNTIME: 'claude-code', MUKUROJI_MCP_INSTANCE_ID: 'instance-a' })
    expect((await call(client, 'get_configuration')).content).toMatchObject({ data: { catalog: { templates: [
      { id: 'release-check', name: 'Release check', acceptanceCriteria: ['Tests pass'] },
    ] } } })
    for (const input of [{ templateId: 'release-check' }, { templateId: 'release-check', priority: 'low' }, {}]) {
      const created = await call(client, 'create_task', { title: 'Release', idempotencyKey: crypto.randomUUID(), ...input })
      expect(created.isError).toBe(false)
    }

    expect(fake.createBodies).toHaveLength(3)
    expect(fake.createBodies[0]).toMatchObject({ templateId: 'release-check' })
    expect(fake.createBodies[0]).not.toHaveProperty('priority')
    expect(fake.createBodies[1]).toMatchObject({ templateId: 'release-check', priority: 'low' })
    expect(fake.createBodies[2]).toMatchObject({ priority: 'medium' })
    expect(fake.createBodies[2]).not.toHaveProperty('templateId')
  } finally {
    await client?.close()
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
    // The checksum file verifies both published files in `sha256sum -c` format.
    const checksums = await Bun.file(join(outdir, 'mcp.mjs.sha256')).text()
    for (const file of ['mcp.mjs', 'mcp.mjs.LICENSES.txt']) {
      const digest = new Bun.CryptoHasher('sha256').update(await Bun.file(join(outdir, file)).arrayBuffer()).digest('hex')
      expect(checksums).toContain(`${digest}  ${file}\n`)
    }
    const version = Bun.spawn([node, join(outdir, 'mcp.mjs'), '--version'], { stdout: 'pipe', stderr: 'pipe', env: {} })
    expect(await version.exited).toBe(0)
    expect((await new Response(version.stdout).text()).trim()).toBe(CODING_AGENT_MCP_VERSION)
    client = await connect(fake.api.port, 'auto', { MUKUROJI_MCP_RUNTIME: 'codex' }, join(outdir, 'mcp.mjs'), node)
    expect((await client.listTools()).tools).toHaveLength(22)
    expect((await call(client, 'get_configuration')).content).toMatchObject({
      data: { runtime: 'codex', mcp: { version: CODING_AGENT_MCP_VERSION, serverCompatibility: { status: 'compatible' } } },
    })
  } finally {
    await client?.close()
    await fake.api.stop(true)
    await rm(outdir, { recursive: true, force: true })
  }
}, 30_000)

test('reuses a known server compatibility and retries an unknown one', async () => {
  let healthRequests = 0
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/api/health') return Response.json({}, { status: 404 })
    healthRequests += 1
    // The first read fails as a transient outage would; later reads report the range.
    return healthRequests === 1 ? Response.json({}, { status: 503 })
      : Response.json({ ok: true, status: 'alive', codingAgentMcp: { apiRevision: 8, minimumApiRevision: 1 } })
  } })
  try {
    const factory = composeCodingAgentMcp({ MUKUROJI_MCP_URL: `http://127.0.0.1:${api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token',
      MUKUROJI_MCP_TEAM_ID: 'team', MUKUROJI_MCP_ASSIGNEE_ID: 'agent' })
    expect((await factory.serverCompatibility()).status).toBe('unknown')
    expect((await factory.serverCompatibility()).status).toBe('compatible')
    expect((await factory.serverCompatibility()).status).toBe('compatible')
    expect(healthRequests).toBe(2)
  } finally {
    await api.stop(true)
  }
})

test('several configured Teams let create_task choose its Team, and one Team keeps the old schema', async () => {
  const fake = startFakeApi()
  const clients: Client[] = []
  try {
    const single = await connect(fake.api.port, 'auto', {})
    clients.push(single)
    const multi = await connect(fake.api.port, 'auto', { MUKUROJI_MCP_TEAM_IDS: 'team-b' })
    clients.push(multi)
    /** Reads the argument names of create_task. */
    const createArguments = async (client: Client) =>
      Object.keys((await client.listTools()).tools.find((tool) => tool.name === 'create_task')?.inputSchema.properties ?? {})
    expect(await createArguments(single)).not.toContain('teamId')
    expect(await createArguments(multi)).toContain('teamId')
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await fake.api.stop(true)
  }
})

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

/**
 * Starts a fake public API for the Workspace profile, which fixes no Team.
 *
 * @returns The server and the requests it received.
 */
function startFakeWorkspaceApi() {
  const requests: string[] = []
  const writes: { method: string, path: string, key: string | null, body: unknown }[] = []
  const issue = { id: 'task', teamId: 'team', revision: 2, title: 'Import GitHub issue', assigneeUserId: 'owner',
    workflowStatusId: 'todo', statusCategory: 'unstarted', priority: 'medium', dueDate: '',
    schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }
  const milestone = { id: 'ms-1', type: 'milestone', title: 'Alpha', teamId: 'team', ownerMemberId: 'owner', status: 'planned',
    health: 'unknown', risk: 'none', progress: 0, linkedWorkItemCount: 0,
    baseline: { startDate: '2026-12-01', endDate: '2026-12-10' }, forecast: { startDate: '2026-12-01', endDate: '2026-12-10' },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const statusUpdate = { id: 'pu-1', version: 1, target: { type: 'project', teamId: 'team', projectId: 'project' }, health: 'on-track',
    risk: 'none', summary: 'On plan.', riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '',
    progress: { percent: 40, linkedWorkItemCount: 5 }, authorMemberId: 'owner', coveredDueAt: '2026-09-04T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z' }
  const documentContent = { schemaVersion: 1, id: 'doc-1', kind: 'page', title: 'Spec', revision: 4,
    updatedAt: '2026-09-01T00:00:00.000Z', format: 'markdown', content: '# Spec\n\nShip it.\n' }
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true, codingAgentMcp: { apiRevision: 8, minimumApiRevision: 1 } })
    if (request.headers.get('Authorization') !== 'Bearer isolated-test-token') return Response.json({}, { status: 401 })
    requests.push(`${url.pathname}${url.search}`)
    const teamId = url.searchParams.get('teamId')
    if (request.method !== 'GET') {
      const body: unknown = request.method === 'DELETE' ? undefined : await request.json()
      writes.push({ method: request.method, path: `${url.pathname}${url.search}`, key: request.headers.get('Idempotency-Key'), body })
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items') {
        return Response.json({ ...issue, id: 'created', title: 'Track imports', revision: 1 }, { status: 201 })
      }
      if (request.method === 'PATCH' && url.pathname === '/api/v1/work-items/task' && teamId === 'team') {
        return Response.json({ ...issue, revision: 3, priority: 'high' })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items/created/relations' && teamId === 'team') {
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'created', relation: { type: 'parent', targetWorkItemId: 'task' } }, { status: 201 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items/task/relations' && teamId === 'team') {
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', relation: { type: 'blockedBy', targetWorkItemId: 'other-task' } }, { status: 201 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items/task/web-links' && teamId === 'team') {
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', link: { id: 'dddddddddddddddddddddddddddddddd', url: 'https://github.com/o/r/pull/7', title: 'PR 7', createdByMemberId: 'owner', createdAt: '2026-09-01T00:00:00.000Z' } }, { status: 201 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items/task/subtask-batches' && teamId === 'team') {
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', subtaskCount: 1 }, { status: 201 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/documents') {
        return Response.json({ id: 'doc-new', kind: 'page', title: 'Plan', scope: { type: 'project', projectId: 'project' }, revision: 1 }, { status: 201 })
      }
      if (request.method === 'PATCH' && url.pathname === '/api/v1/documents/doc-1') {
        return Response.json({ id: 'doc-1', kind: 'page', title: 'Spec', scope: { type: 'project', projectId: 'project' }, revision: 5 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/work-items/task/comments' && teamId === 'team') {
        return Response.json({ id: 'new-comment', actorUserId: 'owner', body: 'Linked to PR', createdAt: issue.createdAt }, { status: 201 })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/planning/milestones') {
        return Response.json({ schemaVersion: 1, revision: 8, item: { ...milestone, title: 'Beta' } }, { status: 201 })
      }
      if (request.method === 'PUT' && url.pathname === '/api/v1/work-items/created/planning' && teamId === 'team') {
        return Response.json({ schemaVersion: 1, revision: 9, teamId: 'team', workItemId: 'created', cycleId: 'cycle-1', goalIds: [] })
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/planning/status-updates') {
        return Response.json({ schemaVersion: 1, revision: 10, item: statusUpdate }, { status: 201 })
      }
      return Response.json({}, { status: 404 })
    }
    switch (url.pathname) {
      case '/api/v1/planning/entities':
        return url.searchParams.get('type') === 'milestone'
          ? Response.json({ schemaVersion: 1, revision: 7, items: [milestone] })
          : Response.json({ schemaVersion: 1, revision: 7, items: [] })
      case '/api/v1/planning/status-updates':
        return Response.json({ schemaVersion: 1, revision: 7, items: [statusUpdate], hasMore: false })
      case '/api/v1/documents':
        return Response.json({ items: [{ id: 'doc-1', kind: 'page', title: 'Spec', scope: { type: 'project', projectId: 'project' }, revision: 4 }], hasMore: false })
      case '/api/v1/documents/doc-1':
        return Response.json(documentContent)
      case '/api/v1/work-items/task/documents':
        return Response.json({ items: [{ id: 'doc-1', title: 'Spec' }], hasMore: false })
      case '/api/v1/me':
        return Response.json({ schemaVersion: 1, workspaceId: 'workspace', memberId: 'owner', email: 'owner@example.com' })
      case '/api/v1/teams':
        return Response.json({ schemaVersion: 1, items: [
          { id: 'team', name: 'Platform', projects: [{ id: 'project', name: 'WBS', lifecycleState: 'active', code: 'WBS' }] },
          { id: 'other', name: 'Other', projects: [] },
        ] })
      case '/api/v1/work-item-keys/ABC-7':
        return Response.json({ schemaVersion: 1, key: 'ABC-7', teamId: 'team', workItemId: 'task' })
      case '/api/v1/work-item-keys/ABC-8':
        return Response.json({ schemaVersion: 1, key: 'ABC-8', teamId: 'team', workItemId: 'other-task' })
      case '/api/v1/work-items/task/hierarchy':
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', parentWorkItemId: null, childWorkItemIds: ['created'], wbsNumber: '3' })
      case '/api/v1/work-items/task/relations':
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', relations: [{ type: 'blockedBy', targetWorkItemId: 'other-task' }] })
      case '/api/v1/work-items/task/web-links':
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', items: [{ id: 'dddddddddddddddddddddddddddddddd', url: 'https://github.com/o/r/pull/7', title: 'PR 7', createdByMemberId: 'owner', createdAt: '2026-09-01T00:00:00.000Z' }] })
      case '/api/v1/work-items/created/key':
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'created', createdAt: issue.createdAt, key: 'ABC-9' })
      case '/api/v1/work-items/task':
        return teamId === 'team' ? Response.json(issue) : Response.json({}, { status: 404 })
      case '/api/v1/work-items/task/key':
        return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', createdAt: issue.createdAt, key: 'ABC-7' })
      case '/api/v1/work-items/task/comments':
        return Response.json({ items: [{ id: 'comment', actorUserId: 'owner', body: 'Imported', createdAt: issue.createdAt }], hasMore: false })
      case '/api/v1/work-items':
        return Response.json({ items: teamId === 'team' ? [issue] : [], hasMore: false })
      case '/api/v1/projects/project/charter':
        return teamId === 'team'
          ? Response.json({ schemaVersion: 1, teamId: 'team', projectId: 'project', lifecycleState: 'active', revision: 2, code: 'WBS', purpose: 'Plan work', tags: [], repositoryUrls: [] })
          : Response.json({}, { status: 404 })
      case '/api/v1/projects/project/members':
        return Response.json({ schemaVersion: 1, teamId: 'team', projectId: 'project', items: [{ id: 'owner', email: 'owner@example.com', role: 'manager' }] })
      case '/api/v1/work-item-types':
        return Response.json({ teamId: 'team', configurationRevision: 1, workItemTypes: [{ id: 'task-type', name: 'Task', customFields: [],
          workflow: { initialStatusId: 'todo', statuses: [
            { id: 'done', name: 'Done', category: 'completed', sortOrder: 2 },
            { id: 'todo', name: 'To do', category: 'unstarted', sortOrder: 1 },
          ] } }] })
      default:
        return Response.json({}, { status: 404 })
    }
  } })
  return { api, requests, writes }
}

test('the workspace profile reads Teams, members, statuses, and Work Items by key without a fixed Team', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token', MUKUROJI_MCP_PROFILE: 'workspace' },
      stderr: 'pipe',
    }))
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
    expect(tools).toEqual([
      'create_subtasks', 'delete_attachment', 'get_document', 'get_issue', 'get_project', 'get_status_updates', 'list_attachments', 'list_comments', 'list_cycles',
      'list_documents', 'list_issue_statuses', 'list_issues', 'list_milestones', 'list_planning_entities', 'list_projects', 'list_relations', 'list_teams', 'list_users',
      'save_attachment', 'save_comment', 'save_document', 'save_issue', 'save_milestone', 'save_relation', 'save_status_update', 'whoami',
    ])

    expect((await call(client, 'list_projects', { teamId: 'team' })).content).toEqual({
      data: [{ id: 'project', name: 'WBS', lifecycleState: 'active', code: 'WBS', teamId: 'team', teamName: 'Platform' }],
    })
    expect((await call(client, 'get_issue', { id: 'abc-7' })).content).toMatchObject({ data: { id: 'task', teamId: 'team', key: 'ABC-7' } })
    expect((await call(client, 'list_comments', { issueId: 'ABC-7' })).content).toMatchObject({
      data: { teamId: 'team', workItemId: 'task', items: [{ id: 'comment', body: 'Imported' }], hasMore: false },
    })
    expect((await call(client, 'list_issues', { teamId: 'team', assigneeId: 'me' })).content).toMatchObject({ data: { items: [{ id: 'task' }] } })
    expect((await call(client, 'get_project', { projectId: 'project' })).content).toMatchObject({
      data: { id: 'project', teamId: 'team', teamName: 'Platform', charterReadable: true, purpose: 'Plan work', revision: 2 },
    })
    // Without a Team the list reads one Team per page and hands back a cursor for the next Team.
    const firstTeam = await call(client, 'list_issues', { query: 'github  IMPORT' })
    expect(firstTeam.content).toMatchObject({ data: { items: [{ id: 'task' }], hasMore: true } })
    const firstData: unknown = typeof firstTeam.content !== 'object' || firstTeam.content === null ? undefined : Reflect.get(firstTeam.content, 'data')
    const nextCursor: unknown = typeof firstData === 'object' && firstData !== null ? Reflect.get(firstData, 'nextCursor') : undefined
    expect(typeof nextCursor).toBe('string')
    expect((await call(client, 'list_issues', { query: 'github  IMPORT', cursor: nextCursor })).content).toEqual({ data: { items: [], hasMore: false } })
    expect((await call(client, 'list_users', { teamId: 'team', projectId: 'project' })).content).toMatchObject({ data: { items: [{ id: 'owner' }] } })
    expect((await call(client, 'list_issue_statuses', { teamId: 'team' })).content).toEqual({ data: { teamId: 'team', workItemTypes: [{
      id: 'task-type', name: 'Task', customFields: [], statuses: [
        { id: 'todo', name: 'To do', category: 'unstarted', initial: true },
        { id: 'done', name: 'Done', category: 'completed', initial: false },
      ],
    }] } })
    // With a Team the value is an ID even when it looks like a key.
    expect((await call(client, 'get_issue', { id: 'task', teamId: 'team' })).content).toMatchObject({ data: { id: 'task', key: 'ABC-7' } })
    const keyLikeId = await call(client, 'get_issue', { id: 'ABC-7', teamId: 'team' })
    expect(keyLikeId.content).toMatchObject({ error: { code: 'not_found' } })
    const withoutTeam = await call(client, 'get_issue', { id: 'task' })
    expect(withoutTeam.isError).toBe(true)
    expect(withoutTeam.content).toMatchObject({ error: { code: 'invalid_request' } })

    expect(fake.requests).toContain('/api/v1/work-items?teamId=team&assigneeUserId=owner&limit=50')
    expect(fake.requests).toContain('/api/v1/work-items?teamId=team&query=github++IMPORT&limit=50')
    expect(fake.requests).toContain('/api/v1/work-items?teamId=other&query=github++IMPORT&limit=50')
    expect(fake.requests.some((path) => path.startsWith('/api/v1/agent-'))).toBe(false)
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the workspace profile creates and updates Work Items and adds comments by key', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  const keys = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token', MUKUROJI_MCP_PROFILE: 'workspace' },
      stderr: 'pipe',
    }))

    expect((await call(client, 'save_issue', {
      teamId: 'team', title: 'Track imports', projectId: 'project', idempotencyKey: keys[0],
    })).content).toMatchObject({ data: { id: 'created', revision: 1 } })
    expect((await call(client, 'save_issue', {
      id: 'ABC-7', priority: 'high', assigneeId: 'me', expectedRevision: 2, idempotencyKey: keys[1],
    })).content).toMatchObject({ data: { id: 'task', revision: 3, key: 'ABC-7' } })
    expect((await call(client, 'save_comment', { issueId: 'ABC-7', body: 'Linked to PR', idempotencyKey: keys[2] })).content)
      .toMatchObject({ data: { teamId: 'team', workItemId: 'task', comment: { id: 'new-comment' } } })

    expect(fake.writes).toEqual([
      { method: 'POST', path: '/api/v1/work-items', key: keys[0], body: {
        teamId: 'team', title: 'Track imports', assigneeUserId: 'owner', priority: 'medium', assignedProjectId: 'project',
      } },
      { method: 'PATCH', path: '/api/v1/work-items/task?teamId=team', key: keys[1], body: {
        expectedRevision: 2, assigneeUserId: 'owner', priority: 'high',
      } },
      { method: 'POST', path: '/api/v1/work-items/task/comments?teamId=team', key: keys[2], body: { body: 'Linked to PR' } },
    ])

    const withoutRevision = await call(client, 'save_issue', { id: 'ABC-7', title: 'Renamed', idempotencyKey: keys[1] })
    expect(withoutRevision.isError).toBe(true)
    expect(withoutRevision.content).toMatchObject({ error: { code: 'invalid_request' } })
    const withoutTitle = await call(client, 'save_issue', { teamId: 'team', idempotencyKey: keys[0] })
    expect(withoutTitle.content).toMatchObject({ error: { code: 'invalid_request' } })
    const nothingToChange = await call(client, 'save_issue', { id: 'ABC-7', expectedRevision: 3, idempotencyKey: keys[1] })
    expect(nothingToChange.content).toMatchObject({ error: { code: 'invalid_request' } })
    // The Public API takes up to 4096 characters for an updated description and for a comment.
    const longUpdate = await call(client, 'save_issue', { id: 'ABC-7', expectedRevision: 3, description: 'x'.repeat(4097), idempotencyKey: keys[1] })
    expect(longUpdate.content).toMatchObject({ error: { code: 'invalid_request' } })
    const longComment = await call(client, 'save_comment', { issueId: 'ABC-7', body: 'x'.repeat(4097), idempotencyKey: keys[2] })
    expect(longComment.isError).toBe(true)
    expect(fake.writes).toHaveLength(3)
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the workspace profile breaks a Work Item down into subtasks and links Work Items by key', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  const keys = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013']
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token', MUKUROJI_MCP_PROFILE: 'workspace' },
      stderr: 'pipe',
    }))

    expect((await call(client, 'create_subtasks', {
      parentId: 'ABC-7', subtasks: [{ title: 'Track imports' }], idempotencyKey: keys[0],
    })).content).toEqual({ data: { teamId: 'team', workItemId: 'task', subtasks: [{ id: 'created', title: 'Track imports', key: 'ABC-9' }] } })
    expect((await call(client, 'save_relation', {
      issueId: 'ABC-7', type: 'blockedBy', relatedIssueId: 'ABC-8', idempotencyKey: keys[1],
    })).content).toEqual({ data: { teamId: 'team', workItemId: 'task', removed: false, relation: { type: 'blockedBy', relatedIssueId: 'other-task' } } })
    expect((await call(client, 'list_relations', { issueId: 'ABC-7' })).content).toEqual({ data: {
      teamId: 'team', workItemId: 'task', parentId: null, childIds: ['created'], wbsNumber: '3',
      relations: [{ type: 'blockedBy', relatedIssueId: 'other-task' }],
    } })
    expect((await call(client, 'save_attachment', {
      issueId: 'ABC-7', url: 'https://github.com/o/r/pull/7', title: 'PR 7', idempotencyKey: keys[2],
    })).content).toMatchObject({ data: { teamId: 'team', workItemId: 'task', attachment: { url: 'https://github.com/o/r/pull/7', title: 'PR 7', createdById: 'owner' } } })
    expect((await call(client, 'list_attachments', { issueId: 'ABC-7' })).content).toMatchObject({ data: {
      attachments: [{ id: 'dddddddddddddddddddddddddddddddd', url: 'https://github.com/o/r/pull/7' }],
    } })
    expect((await call(client, 'save_attachment', {
      issueId: 'ABC-7', url: 'javascript:alert(1)', idempotencyKey: keys[2],
    })).isError).toBe(true)
    const tooMany = await call(client, 'create_subtasks', {
      parentId: 'ABC-7', subtasks: Array.from({ length: 21 }, (_, index) => ({ title: `Part ${index}` })), idempotencyKey: keys[0],
    })
    expect(tooMany.isError).toBe(true)

    expect(fake.writes).toEqual([
      { method: 'POST', path: '/api/v1/work-items/task/subtask-batches?teamId=team', key: `${keys[0]}.batch`, body: {
        subtasks: [{ title: 'Track imports', assigneeUserId: 'owner', priority: 'medium' }],
      } },
      { method: 'POST', path: '/api/v1/work-items', key: `${keys[0]}.subtask.0`, body: {
        teamId: 'team', title: 'Track imports', assigneeUserId: 'owner', priority: 'medium',
      } },
      { method: 'POST', path: '/api/v1/work-items/created/relations?teamId=team', key: `${keys[0]}.subtask.0.parent`, body: {
        type: 'parent', targetWorkItemId: 'task',
      } },
      { method: 'POST', path: '/api/v1/work-items/task/relations?teamId=team', key: keys[1], body: {
        type: 'blockedBy', targetWorkItemId: 'other-task',
      } },
      { method: 'POST', path: '/api/v1/work-items/task/web-links?teamId=team', key: keys[2], body: {
        url: 'https://github.com/o/r/pull/7', title: 'PR 7',
      } },
    ])
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the workspace profile reads and writes Milestones, Cycles, and health updates', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  const keys = ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000023']
  const target = { type: 'project', teamId: 'team', projectId: 'project' }
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token', MUKUROJI_MCP_PROFILE: 'workspace' },
      stderr: 'pipe',
    }))
    expect((await call(client, 'list_milestones', { teamId: 'team' })).content).toMatchObject({ data: { revision: 7, items: [{ id: 'ms-1' }] } })
    expect((await call(client, 'get_status_updates', { target })).content).toMatchObject({ data: { items: [{ id: 'pu-1', health: 'on-track' }] } })
    expect((await call(client, 'save_milestone', {
      title: 'Beta', parentId: 'initiative', teamId: 'team', targetDate: '2026-12-20', idempotencyKey: keys[0],
    })).content).toMatchObject({ data: { revision: 8, item: { title: 'Beta' } } })
    expect((await call(client, 'save_issue', {
      teamId: 'team', title: 'Track imports', cycleId: 'cycle-1', idempotencyKey: keys[1],
    })).content).toMatchObject({ data: { id: 'created', cycleId: 'cycle-1' } })
    expect((await call(client, 'save_status_update', {
      target, health: 'on-track', summary: 'On plan.', idempotencyKey: keys[2],
    })).content).toMatchObject({ data: { item: { id: 'pu-1' } } })

    expect((await call(client, 'list_planning_entities', { type: 'initiative' })).content).toMatchObject({ data: { items: [] } })
    expect(fake.requests).toContain('/api/v1/planning/entities?type=milestone&teamId=team')
    expect(fake.requests).toContain('/api/v1/planning/entities?type=initiative')
    expect(fake.requests).toContain('/api/v1/planning/status-updates?targetType=project&teamId=team&projectId=project&limit=20')
    expect(fake.writes).toEqual([
      { method: 'POST', path: '/api/v1/planning/milestones', key: keys[0], body: {
        title: 'Beta', parentId: 'initiative', teamId: 'team', targetDate: '2026-12-20',
      } },
      { method: 'POST', path: '/api/v1/work-items', key: keys[1], body: {
        teamId: 'team', title: 'Track imports', assigneeUserId: 'owner', priority: 'medium',
      } },
      { method: 'PUT', path: '/api/v1/work-items/created/planning?teamId=team', key: `${keys[1]}.planning`, body: { cycleId: 'cycle-1' } },
      { method: 'POST', path: '/api/v1/planning/status-updates', key: keys[2], body: { target, health: 'on-track', summary: 'On plan.' } },
    ])
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the workspace profile lists, reads, creates, and updates Documents as Markdown', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  const keys = ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022']
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: { MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token', MUKUROJI_MCP_PROFILE: 'workspace' },
      stderr: 'pipe',
    }))

    expect((await call(client, 'list_documents', { projectId: 'project' })).content).toMatchObject({
      data: { items: [{ id: 'doc-1', kind: 'page', revision: 4 }], hasMore: false },
    })
    expect((await call(client, 'list_documents', { issueId: 'ABC-7' })).content).toEqual({
      data: { teamId: 'team', workItemId: 'task', items: [{ id: 'doc-1', title: 'Spec' }], hasMore: false },
    })
    expect((await call(client, 'get_document', { id: 'doc-1' })).content).toMatchObject({ data: { id: 'doc-1', revision: 4, content: '# Spec\n\nShip it.\n' } })
    expect((await call(client, 'save_document', {
      title: 'Plan', content: '## Goals', projectId: 'project', issueId: 'ABC-7', idempotencyKey: keys[0],
    })).content).toMatchObject({ data: { id: 'doc-new', revision: 1 } })
    expect((await call(client, 'save_document', {
      id: 'doc-1', content: 'Ship it now.', expectedRevision: 4, idempotencyKey: keys[1],
    })).content).toMatchObject({ data: { id: 'doc-1', revision: 5 } })

    expect(fake.requests).toContain('/api/v1/documents?projectId=project&limit=50')
    expect(fake.writes).toEqual([
      { method: 'POST', path: '/api/v1/documents', key: keys[0], body: {
        title: 'Plan', content: '## Goals', projectId: 'project', workItem: { teamId: 'team', workItemId: 'task' },
      } },
      { method: 'PATCH', path: '/api/v1/documents/doc-1', key: keys[1], body: { expectedRevision: 4, content: 'Ship it now.' } },
    ])
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the read-only workspace profile leaves out the write tools', async () => {
  const fake = startFakeWorkspaceApi()
  const client = new Client({ name: 'mukuroji-integration-test', version: '1.0.0' })
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [handlerPath],
      env: {
        MUKUROJI_MCP_URL: `http://127.0.0.1:${fake.api.port}`, MUKUROJI_MCP_TOKEN: 'isolated-test-token',
        MUKUROJI_MCP_PROFILE: 'workspace', MUKUROJI_MCP_READ_ONLY: 'true',
      },
      stderr: 'pipe',
    }))
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).not.toContain('save_issue')
    expect(tools).not.toContain('save_comment')
    expect(tools).not.toContain('save_relation')
    expect(tools).not.toContain('create_subtasks')
    expect(tools).not.toContain('save_attachment')
    expect(tools).not.toContain('delete_attachment')
    expect(tools).toContain('list_attachments')
    expect(tools).not.toContain('save_milestone')
    expect(tools).not.toContain('save_status_update')
    expect(tools).not.toContain('save_document')
    expect(tools).toContain('get_issue')
    expect(tools).toContain('list_documents')
    expect(tools).toContain('get_document')
    expect(tools).toContain('list_relations')
    expect(tools).toContain('list_milestones')
    expect(tools).toContain('get_status_updates')
  } finally {
    await client.close()
    await fake.api.stop(true)
  }
})

test('the workspace profile needs only the origin and token, and rejects an unknown profile', () => {
  expect(() => composeCodingAgentMcp({ MUKUROJI_MCP_PROFILE: 'workspace', MUKUROJI_MCP_TOKEN: 'never-print-this' })).toThrow('workspace profile')
  expect(() => composeCodingAgentMcp({ MUKUROJI_MCP_PROFILE: 'linear' })).toThrow('MUKUROJI_MCP_PROFILE')
  expect(() => composeCodingAgentMcp({
    MUKUROJI_MCP_PROFILE: 'workspace', MUKUROJI_MCP_URL: 'http://127.0.0.1:3000', MUKUROJI_MCP_TOKEN: 'token',
  })).not.toThrow()
})

test('a Project restriction needs exactly one Team', () => {
  expect(() => composeCodingAgentMcp({
    MUKUROJI_MCP_URL: 'http://127.0.0.1:3000', MUKUROJI_MCP_TOKEN: 'token', MUKUROJI_MCP_TEAM_IDS: 'team-a,team-b',
    MUKUROJI_MCP_ASSIGNEE_ID: 'agent', MUKUROJI_MCP_PROJECT_ID: 'project',
  })).toThrow('MUKUROJI_MCP_PROJECT_ID needs exactly one Team')
  expect(() => composeCodingAgentMcp({
    MUKUROJI_MCP_URL: 'http://127.0.0.1:3000', MUKUROJI_MCP_TOKEN: 'token', MUKUROJI_MCP_TEAM_IDS: 'team-a',
    MUKUROJI_MCP_ASSIGNEE_ID: 'agent', MUKUROJI_MCP_PROJECT_ID: 'project',
  })).not.toThrow()
})

describe('readTeamIds', () => {
  test('keeps the single Team of an older configuration', () => {
    expect(readTeamIds('team-a', undefined)).toEqual(['team-a'])
  })

  test('adds listed Teams in order without duplicates', () => {
    expect(readTeamIds('team-a', 'team-b, team-a ,team-c')).toEqual(['team-a', 'team-b', 'team-c'])
    expect(readTeamIds(undefined, 'team-b')).toEqual(['team-b'])
  })

  test('rejects no Team, an empty entry, and too many Teams', () => {
    expect(() => readTeamIds(undefined, undefined)).toThrow(AgentTaskError)
    expect(() => readTeamIds(undefined, 'team-a,,team-b')).toThrow(AgentTaskError)
    expect(() => readTeamIds(undefined, Array.from({ length: 11 }, (_, index) => `team-${index}`).join(','))).toThrow(AgentTaskError)
  })
})
