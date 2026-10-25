import { describe, expect, test } from 'bun:test'
import { createAgentTasks } from './agent-tasks'
import type { AgentRunMutationFence, TeamIssueCommentResponseItem } from '@mukuroji/contracts'
import {
  AgentTaskError, type AgentCatalog, type AgentRunRecord, type AgentRunReportInput, type AgentRunReportResult, type AgentTask,
  type AgentWorkItemApi,
} from './work-item-api'

/** Creates a minimal validated canonical task projection. */
function task(id = 'one', patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id, teamId: 'team', revision: 1, title: id, description: 'Original instructions',
    assigneeUserId: 'agent-member', workflowStatusId: 'todo', statusCategory: 'unstarted',
    priority: 'medium', dueDate: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    relationIds: [], customFieldValues: {}, ...patch,
  }
}

const catalog: AgentCatalog = {
  teamId: 'team', configurationRevision: 1,
  workItemTypes: [{ id: 'default', name: 'Task', customFields: [], workflow: {
    initialStatusId: 'todo', statuses: [
      { id: 'todo', name: 'Todo', category: 'unstarted', sortOrder: 0 },
      { id: 'coding', name: 'Coding', category: 'started', sortOrder: 1 },
      { id: 'review', name: 'Review', category: 'started', sortOrder: 2 },
      { id: 'shipped', name: 'Done', category: 'completed', sortOrder: 3 },
      { id: 'canceled', name: 'Canceled', category: 'canceled', sortOrder: 4 },
    ],
  } }],
}

/** Scope shared by tests unless a test needs another instance or Project. */
const baseScope = { assigneeUserId: 'agent-member', agentName: 'test-agent', runtime: 'claude-code', instanceId: 'instance-a' } as const

/** Builds an in-memory CAS API with durable mutation receipts and run claims for lifecycle tests. */
function fixture(initial: AgentTask[] = [task()], overrides: Partial<AgentWorkItemApi> = {}) {
  const records = new Map(initial.map((item) => [item.id, structuredClone(item)]))
  const receipts = new Map<string, { fingerprint: string; task: AgentTask }>()
  const notes: string[] = []
  const reports: (AgentRunReportInput & { runId: string })[] = []
  const reportReceipts = new Map<string, { runId: string; result: AgentRunReportResult }>()
  const commentReceipts = new Map<string, { fingerprint: string; comment: TeamIssueCommentResponseItem }>()
  const fences: (AgentRunMutationFence | undefined)[] = []
  const runs = new Map<string, AgentRunRecord & { instanceId: string }>()
  let runSequence = 0
  const startReceipts = new Map<string, { fingerprint: string; response: { run: AgentRunRecord; task: AgentTask } }>()
  /** Projects a stored run without the raw instance ID, as the server does. */
  const publicRun = ({ instanceId: _instanceId, ...run }: AgentRunRecord & { instanceId: string }): AgentRunRecord => structuredClone(run)
  const api: AgentWorkItemApi = {
    async catalog() { return catalog },
    async get(id) {
      const found = records.get(id)
      if (!found) throw new AgentTaskError('not_found', 'Not found')
      return structuredClone(found)
    },
    async list(filters) {
      return {
        items: [...records.values()].filter((item) =>
          (!filters.assigneeUserId || item.assigneeUserId === filters.assigneeUserId) &&
          (!filters.assignedProjectId || item.assignedProjectId === filters.assignedProjectId)),
        hasMore: false,
      }
    },
    async create(input) {
      const created = task('created', input)
      records.set(created.id, created)
      return created
    },
    async update(id, input, key, fence) {
      fences.push(fence)
      const holder = [...runs.values()].find((run) => run.workItemId === id && run.state === 'active')
      if (holder && fence && holder.instanceId !== fence.agentInstanceId) throw new AgentTaskError('agent_run_conflict', 'Held')
      const fingerprint = JSON.stringify({ id, input })
      const receipt = receipts.get(key)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new AgentTaskError('conflict', 'Different input')
        return structuredClone(receipt.task)
      }
      const before = records.get(id)
      if (!before || before.revision !== input.expectedRevision) throw new AgentTaskError('conflict', 'Changed')
      const status = catalog.workItemTypes[0].workflow.statuses.find((item) => item.id === input.workflowStatusId)
      const after: AgentTask = { ...before, revision: before.revision + 1,
        ...(input.title ? { title: input.title } : {}),
        ...(status ? { workflowStatusId: status.id, statusCategory: status.category } : {}),
      }
      records.set(id, after)
      receipts.set(key, { fingerprint, task: after })
      return structuredClone(after)
    },
    async comments() { return { items: [], hasMore: false } },
    async comment(id, body, key, _project, _assignee, fence) {
      fences.push(fence)
      // Like the server, one key holds one receipt per credential whichever endpoint saved it.
      const fingerprint = JSON.stringify({ id, body, fence })
      const replay = commentReceipts.get(key)
      if (reportReceipts.has(key) || (replay && replay.fingerprint !== fingerprint)) throw new AgentTaskError('idempotency_conflict', 'Different request')
      if (replay) return structuredClone(replay.comment)
      notes.push(body)
      const comment = { id: 'comment', actorUserId: 'agent-member', body, createdAt: '2026-09-01T00:00:00.000Z' }
      commentReceipts.set(key, { fingerprint, comment })
      return structuredClone(comment)
    },
    async startRun(id, input, key) {
      const replay = startReceipts.get(key)
      if (replay) {
        if (replay.fingerprint !== JSON.stringify({ id, input })) throw new AgentTaskError('conflict', 'Different input')
        return structuredClone(replay.response)
      }
      if ([...runs.values()].some((run) => run.workItemId === id && run.state === 'active')) {
        throw new AgentTaskError('agent_run_conflict', 'Held')
      }
      const started = await api.update(id, { expectedRevision: input.expectedRevision, workflowStatusId: input.workflowStatusId }, key)
      runSequence += 1
      const run = {
        schemaVersion: 1 as const, runId: `run_00000000-0000-4000-8000-${String(runSequence).padStart(12, '0')}`,
        teamId: 'team', workItemId: id, assigneeUserId: 'agent-member', runtime: input.runtime, agentName: input.agentName,
        state: 'active' as const, startRevision: started.revision, leaseMinutes: 30, startedAt: '2026-09-01T00:00:00.000Z',
        lastHeartbeatAt: '2026-09-01T00:00:00.000Z', leaseExpiresAt: '2026-09-01T00:30:00.000Z', stalled: false, reportCount: 0,
        instanceId: input.instanceId,
      }
      runs.set(run.runId, run)
      const response = { run: publicRun(run), task: started }
      startReceipts.set(key, { fingerprint: JSON.stringify({ id, input }), response })
      return structuredClone(response)
    },
    /**
     * Lists active runs matching the filters.
     *
     * @param filters - Assignee and instance restrictions.
     * @returns One page of active runs.
     */
    async listActiveRuns(filters) {
      return { items: [...runs.values()].filter((run) => run.state === 'active' &&
        (!filters.instanceId || run.instanceId === filters.instanceId) &&
        (!filters.assigneeUserId || run.assigneeUserId === filters.assigneeUserId)).map(publicRun), hasMore: false }
    },
    /**
     * Saves a structured report for an active run of the same instance, labelling its comment like the server.
     *
     * @param runId - Reporting run.
     * @param instanceId - Instance that started the run.
     * @param input - Report fields.
     * @param key - Idempotency key; a reused key replays the saved response like the server.
     * @returns The report, its comment, and the run.
     */
    async reportRun(runId, instanceId, input, key) {
      const replay = reportReceipts.get(key)
      if (commentReceipts.has(key)) throw new AgentTaskError('idempotency_conflict', 'Different request')
      if (replay) {
        if (replay.runId !== runId) throw new AgentTaskError('idempotency_conflict', 'Different request')
        return structuredClone(replay.result)
      }
      const run = runs.get(runId)
      if (!run || run.state !== 'active' || run.instanceId !== instanceId) throw new AgentTaskError('agent_run_not_active', 'Finished')
      const body = `[${run.agentName}]\n\n${input.message}`
      notes.push(body)
      reports.push({ runId, ...input })
      const reported = { ...run, reportCount: run.reportCount + 1 }
      runs.set(runId, reported)
      const result = {
        report: {
          schemaVersion: 1 as const, runId, teamId: 'team', workItemId: run.workItemId, sequence: reported.reportCount,
          kind: input.kind ?? 'progress', commentId: 'comment', verifications: input.verifications ?? [],
          artifacts: input.artifacts ?? [], createdAt: '2026-09-01T00:10:00.000Z',
        },
        comment: { id: 'comment', actorUserId: 'agent-member', body, createdAt: '2026-09-01T00:10:00.000Z' },
        run: publicRun(reported),
      }
      reportReceipts.set(key, { runId, result })
      return structuredClone(result)
    },
    /**
     * Supersedes a stalled run of another instance and starts this instance's run.
     *
     * @param id - Task ID.
     * @param runId - Stalled run.
     * @param input - Runtime, agent name, and instance of the caller.
     * @returns The new run and the superseded run.
     */
    async takeOverRun(id, runId, input) {
      const stalled = runs.get(runId)
      if (!stalled || stalled.state !== 'active' || stalled.workItemId !== id) throw new AgentTaskError('agent_run_not_active', 'Finished')
      if (stalled.instanceId === input.instanceId) throw new AgentTaskError('agent_run_conflict', 'Same instance')
      const superseded = { ...stalled, state: 'finished' as const, outcome: 'superseded' as const, finishedBy: 'agent-member', finishedAt: '2026-09-01T01:00:00.000Z' }
      runs.set(runId, superseded)
      runSequence += 1
      const run = { ...stalled, runId: `run_00000000-0000-4000-8000-${String(runSequence).padStart(12, '0')}`, instanceId: input.instanceId, runtime: input.runtime, agentName: input.agentName }
      runs.set(run.runId, run)
      return { run: publicRun(run), supersededRun: publicRun(superseded) }
    },
    /**
     * Returns the active run of a task when it matches the requested owner.
     *
     * @param id - Task ID.
     * @param owner - Assignee and instance the run must belong to.
     * @returns The claiming run, or undefined.
     */
    async claimedRun(id, owner = {}) {
      const run = [...runs.values()].find((candidate) => candidate.workItemId === id && candidate.state === 'active')
      return run && (!owner.instanceId || run.instanceId === owner.instanceId) &&
        (!owner.assigneeUserId || run.assigneeUserId === owner.assigneeUserId) ? publicRun(run) : undefined
    },
    async getRun(runId) {
      const run = runs.get(runId)
      if (!run) throw new AgentTaskError('not_found', 'Not found')
      return publicRun(run)
    },
    async heartbeat(runId, instanceId) {
      if (runs.get(runId)?.instanceId !== instanceId) throw new AgentTaskError('agent_run_conflict', 'Another instance')
      return api.getRun(runId)
    },
    async finishRun(runId, outcome, instanceId) {
      const run = runs.get(runId)
      if (!run) throw new AgentTaskError('not_found', 'Not found')
      if (run.state !== 'active') throw new AgentTaskError('agent_run_not_active', 'Finished')
      if (run.instanceId !== instanceId) throw new AgentTaskError('agent_run_conflict', 'Another instance')
      runs.set(runId, { ...run, state: 'finished', outcome, finishedBy: 'agent', finishedAt: '2026-09-01T01:00:00.000Z' })
      return api.getRun(runId)
    },
    async agentSettings() {
      return { schemaVersion: 1, teamId: 'team', revision: 0, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false }
    },
    ...overrides,
  }
  /** Releases a run as a person would from the Web application. */
  const release = (runId: string) => {
    const run = runs.get(runId)
    if (run) runs.set(runId, { ...run, state: 'finished', outcome: 'released', finishedBy: 'member', finishedAt: '2026-09-01T01:00:00.000Z' })
  }
  return { api, records, notes, reports, fences, runs, release, service: createAgentTasks(api, baseScope) }
}

describe('agent task lifecycle', () => {
  test('selects ready work across empty pages by priority, then due date, while skipping blockers', async () => {
    const rows = [task('low', { priority: 'low' }), task('later', { priority: 'high', dueDate: '2026-10-03' }),
      task('next', { priority: 'high', dueDate: '2026-10-01' }), task('blocked', { priority: 'high', dueDate: '2026-09-01', relationIds: ['blockedBy:missing'] })]
    let pages = 0
    const { service } = fixture(rows, {
      async list(_filters, cursor) {
        pages += 1
        return cursor ? { items: rows, hasMore: false } : { items: [], hasMore: true, nextCursor: 'page2' }
      },
    })
    expect(await service.next({})).toMatchObject({ action: 'start', task: { id: 'next' }, blockedCount: 1 })
    expect(pages).toBe(2)
  })

  test('resumes only work this instance claimed and counts all statuses', async () => {
    const { service } = fixture([task('ready', { priority: 'high' }), task('active', { workflowStatusId: 'coding', statusCategory: 'started' }), task('done', { statusCategory: 'completed' })])
    // Started work without a run, such as work a person or an older agent started, is not resumed.
    expect(await service.next({})).toMatchObject({ action: 'start', task: { id: 'ready' }, ownRuns: [], otherRuns: [] })
    expect(await service.status({})).toMatchObject({ total: 3, counts: { started: 1, unstarted: 1, completed: 1 } })
    const claimed = await service.transition('ready', 1, 'coding', 'start', 'claim')
    expect(claimed).toMatchObject({ task: { id: 'ready', statusCategory: 'started' }, run: { workItemId: 'ready', state: 'active' } })
    expect(await service.next({})).toMatchObject({ action: 'in_progress', task: { id: 'ready' }, ownRuns: [{ workItemId: 'ready' }] })
  })

  test('reports another instance\'s run without resuming it, skips its task, and fences mutations', async () => {
    const { api, service, fences, release, runs, reports } = fixture([task('first', { priority: 'high' }), task('second')])
    const other = createAgentTasks(api, { ...baseScope, instanceId: 'instance-b', runtime: 'codex' })
    await other.transition('first', 1, 'coding', 'start', 'other-claim')
    const next = await service.next({})
    expect(next).toMatchObject({
      action: 'start', task: { id: 'second' }, ownRuns: [],
      otherRuns: [{ workItemId: 'first', runtime: 'codex', stalled: false }],
      skipped: [],
    })
    expect(JSON.stringify(next)).not.toContain('instance-b')
    await expect(service.transition('first', 2, 'review', 'move', 'steal')).rejects.toMatchObject({ code: 'agent_run_conflict' })
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a' })
    const [held] = [...runs.values()]
    await expect(service.finishRun(held?.runId ?? '', 'completed', 'finish')).rejects.toMatchObject({ code: 'not_own_run' })
    await expect(service.heartbeat(held?.runId ?? '')).rejects.toMatchObject({ code: 'not_own_run' })
    expect(await service.get('first')).toMatchObject({ activeRun: { workItemId: 'first', ownedByThisInstance: false } })

    // The other instance holds the run, so its report is saved for that run.
    await other.report('first', { message: 'Progress' }, 'note')
    expect(reports.at(-1)).toEqual({ runId: held?.runId, message: 'Progress' })
    release(held?.runId ?? '')
    expect(await other.next({})).toMatchObject({ ownRuns: [] })
  })

  test('recognizes a run it just started while the run index still lags, and stops after a release', async () => {
    let indexed = false
    const { api, release, fences, reports } = fixture()
    const lagging = createAgentTasks({
      ...api,
      /**
       * Lists active runs once the test marks the run index as caught up.
       *
       * @param filters - Assignee and instance restrictions.
       * @param cursor - Continuation.
       * @returns One page of active runs, empty while the index lags.
       */
      async listActiveRuns(filters, cursor) {
        return indexed ? api.listActiveRuns(filters, cursor) : { items: [], hasMore: false }
      },
    }, baseScope)
    const claimed = await lagging.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    expect(await lagging.get('one')).toMatchObject({ activeRun: { runId, ownedByThisInstance: true } })
    expect(await lagging.heartbeat(runId)).toMatchObject({ runId })
    expect(await lagging.next({})).toMatchObject({ action: 'in_progress', task: { id: 'one' }, ownRuns: [{ runId }] })
    // Its own run is found through the claim, so the report is saved for that run.
    await lagging.report('one', { message: 'Progress' }, 'note')
    expect(reports.at(-1)).toEqual({ runId, message: 'Progress' })
    await lagging.update('one', { expectedRevision: 2, title: 'Renamed' }, 'rename')
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a', agentRunId: runId })
    indexed = true
    release(runId)
    await lagging.report('one', { message: 'After release' }, 'note-2')
    // The claim is gone, so only the instance is sent; the server's revocation check rejects it.
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a' })
    await expect(lagging.heartbeat(runId)).rejects.toMatchObject({ code: 'agent_run_not_active' })
    indexed = false
    expect(await lagging.next({})).toMatchObject({ ownRuns: [] })
  })

  test('resumes its own run after a restart while the run index still lags', async () => {
    const { api } = fixture()
    const lagging = { ...api, async listActiveRuns() { return { items: [], hasMore: false } } }
    const before = createAgentTasks(lagging, baseScope)
    const claimed = await before.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    // A new process keeps no memory of the start; the claim alone identifies the run.
    const restarted = createAgentTasks(lagging, baseScope)
    expect(await restarted.next({})).toMatchObject({ action: 'in_progress', task: { id: 'one' }, ownRuns: [{ runId }] })
    expect(await restarted.get('one')).toMatchObject({ activeRun: { runId, ownedByThisInstance: true } })
    expect(await restarted.heartbeat(runId)).toMatchObject({ runId })
    const other = createAgentTasks(lagging, { ...baseScope, instanceId: 'instance-b' })
    expect(await other.get('one')).toMatchObject({ activeRun: { runId, ownedByThisInstance: false } })
    await expect(other.heartbeat(runId)).rejects.toMatchObject({ code: 'not_own_run' })
  })

  test('does not treat another member run with the same instance ID as its own', async () => {
    const { api, runs, records } = fixture()
    const former = createAgentTasks(api, { ...baseScope, assigneeUserId: 'former-member' })
    const formerTask = records.get('one')
    if (!formerTask) throw new Error('The fixture task must exist.')
    records.set('one', { ...formerTask, assigneeUserId: 'former-member' })
    const claimed = await former.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    const held = runs.get(runId)
    if (!held) throw new Error('The run must be stored.')
    runs.set(runId, { ...held, assigneeUserId: 'former-member' })
    // The task is reassigned while the former member's run, started with the same instance ID, stays active.
    const reassigned = records.get('one')
    if (!reassigned) throw new Error('The fixture task must exist.')
    records.set('one', { ...reassigned, assigneeUserId: 'agent-member' })
    const service = createAgentTasks(api, baseScope)
    expect(await service.get('one')).toMatchObject({ activeRun: { runId, ownedByThisInstance: false } })
    await expect(service.heartbeat(runId)).rejects.toMatchObject({ code: 'not_own_run' })
  })

  test('reports a run released between its read and the claim read as not active', async () => {
    const { api, release } = fixture()
    let releaseOnClaimRead = false
    const racing = createAgentTasks({
      ...api,
      /**
       * Releases the run once before reading the claim, to simulate a concurrent release.
       *
       * @param id - Task ID.
       * @param owner - Assignee and instance the run must belong to.
       * @returns The claiming run, or undefined.
       */
      async claimedRun(id, owner) {
        if (releaseOnClaimRead) {
          releaseOnClaimRead = false
          for (const run of (await api.listActiveRuns({}, undefined)).items) release(run.runId)
        }
        return api.claimedRun(id, owner)
      },
    }, baseScope)
    const claimed = await racing.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    releaseOnClaimRead = true
    await expect(racing.heartbeat(runId)).rejects.toMatchObject({ code: 'agent_run_not_active' })
  })

  test('resumes its own run after a restart even behind many newer started tasks', async () => {
    const newer = Array.from({ length: 12 }, (_, index) => task(`newer-${index}`, {
      workflowStatusId: 'coding', statusCategory: 'started', updatedAt: `2026-09-02T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))
    const { api } = fixture([task(), ...newer])
    const lagging = { ...api, async listActiveRuns() { return { items: [], hasMore: false } } }
    const claimed = await createAgentTasks(lagging, baseScope).transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    const restarted = createAgentTasks(lagging, baseScope)
    expect(await restarted.next({})).toMatchObject({ action: 'in_progress', task: { id: 'one' }, ownRuns: [{ runId }] })
  })

  test('resumes its own run when only the unfiltered run list has caught up', async () => {
    const { api } = fixture()
    const racing = {
      ...api,
      /**
       * Lists active runs, leaving the instance-filtered read behind the unfiltered one.
       *
       * @param filters - Assignee and instance restrictions.
       * @param cursor - Continuation.
       * @returns One page of active runs.
       */
      async listActiveRuns(filters: Parameters<typeof api.listActiveRuns>[0], cursor?: string) {
        // The instance-filtered read ran just before the index exposed the run.
        return filters.instanceId ? { items: [], hasMore: false } : api.listActiveRuns(filters, cursor)
      },
    }
    const tasks = createAgentTasks(racing, baseScope)
    const claimed = await tasks.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    expect(await tasks.next({})).toMatchObject({ action: 'in_progress', ownRuns: [{ runId }], otherRuns: [] })
  })

  test('takes over a run of another instance and continues it as its own', async () => {
    const { api, service } = fixture()
    const claimed = await service.transition('one', 1, 'coding', 'start', 'claim')
    const stalledRunId = 'run' in claimed ? claimed.run.runId : ''
    const successor = createAgentTasks(api, { ...baseScope, instanceId: 'instance-b' })
    const taken = await successor.takeOver('one', stalledRunId, 'take-over')
    expect(taken.supersededRun).toMatchObject({ runId: stalledRunId, state: 'finished', outcome: 'superseded' })
    expect(await successor.next({})).toMatchObject({ action: 'in_progress', task: { id: 'one' }, ownRuns: [{ runId: taken.run.runId }] })
    await expect(service.heartbeat(stalledRunId)).rejects.toMatchObject({ code: 'agent_run_not_active' })
    const unassigned = createAgentTasks(api, { ...baseScope, assigneeUserId: 'someone-else', instanceId: 'instance-c' })
    await expect(unassigned.takeOver('one', taken.run.runId, 'take-over-2')).rejects.toMatchObject({ code: 'not_assigned' })
  })

  test('keeps selecting work once the claim of a task it started is gone', async () => {
    const { api } = fixture()
    let deleted = false
    const lagging = createAgentTasks({
      ...api,
      /**
       * Simulates a run index that has not shown any run yet.
       *
       * @returns An empty page.
       */
      async listActiveRuns() { return { items: [], hasMore: false } },
      /**
       * Reads the claim unless the test has deleted it.
       *
       * @param id - Task ID.
       * @param owner - Assignee and instance the run must belong to.
       * @returns The claiming run, or undefined.
       */
      async claimedRun(id, owner) { return deleted ? undefined : api.claimedRun(id, owner) },
    }, baseScope)
    await lagging.transition('one', 1, 'coding', 'start', 'claim')
    deleted = true
    expect(await lagging.next({})).toMatchObject({ ownRuns: [] })
  })

  test('closes its own run once and forwards a retry of a finished run to the server', async () => {
    const { service } = fixture()
    const claimed = await service.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    expect(await service.heartbeat(runId)).toMatchObject({ runId })
    expect(await service.finishRun(runId, 'paused', 'finish')).toMatchObject({ state: 'finished', outcome: 'paused' })
    await expect(service.finishRun(runId, 'paused', 'finish-again')).rejects.toMatchObject({ code: 'agent_run_not_active' })
    await expect(service.heartbeat(runId)).rejects.toMatchObject({ code: 'agent_run_not_active' })
  })

  test('only one concurrent claimant succeeds; identical uncertain retries replay, changed keys conflict', async () => {
    const { service } = fixture()
    const claims = await Promise.allSettled([
      service.transition('one', 1, 'coding', 'start', 'claim-a'),
      service.transition('one', 1, 'coding', 'start', 'claim-b'),
    ])
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    expect(await service.transition('one', 1, 'coding', 'start', 'claim-a')).toMatchObject({ task: { revision: 2, statusCategory: 'started' } })
    await expect(service.transition('one', 1, 'review', 'start', 'claim-a')).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.transition('one', 2, 'coding', 'start', 'new-claim')).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  test('saves structured reports only for its own run and keeps plain notes as comments without one', async () => {
    const { service, notes, reports, fences, release } = fixture([task(), task('two')])
    const structured = {
      message: 'Ready', kind: 'handoff' as const,
      verifications: [{ command: 'bun test', status: 'passed' as const }],
      artifacts: [{ type: 'pull-request' as const, url: 'https://github.com/example/repo/pull/1' }],
    }
    // Without a run, nothing is saved: neither a report nor a partial comment.
    await expect(service.report('one', structured, 'early')).rejects.toMatchObject({ code: 'agent_run_not_active' })
    await expect(service.report('one', { message: 'Count', changedFileCount: 2 }, 'early-count')).rejects.toMatchObject({ code: 'agent_run_not_active' })
    expect(notes).toEqual([])
    expect(await service.report('one', { message: 'Plan', kind: 'progress' }, 'plain')).toMatchObject({ comment: { id: 'comment' } })
    expect(notes).toEqual(['[test-agent]\n\nPlan'])
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a' })
    const claimed = await service.transition('one', 1, 'coding', 'start', 'claim')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    expect(await service.report('one', structured, 'handoff')).toMatchObject({ report: { kind: 'handoff', sequence: 1 }, run: { reportCount: 1 } })
    expect(reports).toEqual([{ runId, ...structured }])
    // A plain note retried after the run started is sent to the comment endpoint again, with its first fence.
    expect(await service.report('one', { message: 'Plan', kind: 'progress' }, 'plain')).toMatchObject({ comment: { id: 'comment' } })
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a' })
    expect(reports).toHaveLength(1)
    // A key reused for another task is that task's own request and never replays the first task's report.
    await expect(service.report('two', structured, 'handoff')).rejects.toMatchObject({ code: 'agent_run_not_active' })
    // A retry after a lost response reaches the same run's report endpoint even once the run closed.
    release(runId)
    expect(await service.report('one', structured, 'handoff')).toMatchObject({ report: { runId, sequence: 1 } })
    expect(reports).toHaveLength(1)
  })

  test('replays a lost report after a restart from its runId or, for a plain message, from the comment endpoint', async () => {
    const { api, service, notes, reports, fences, release, runs } = fixture([task(), task('two')])
    const structured = { message: 'Ready', kind: 'handoff' as const, verifications: [{ command: 'bun test', status: 'passed' as const }] }
    // A plain message sent before any run, then the run is started and closed and another one started.
    await service.report('one', { message: 'Plan' }, 'plain')
    const first = await service.transition('one', 1, 'coding', 'start', 'claim')
    const firstRunId = 'run' in first ? first.run.runId : ''
    await service.report('one', structured, 'handoff', firstRunId)
    release(firstRunId)
    // The instance claims the task again, as after a person reopened and restarted it.
    const firstRun = runs.get(firstRunId)
    const secondRunId = 'run_00000000-0000-4000-8000-000000000099'
    if (firstRun) runs.set(secondRunId, { ...firstRun, runId: secondRunId, state: 'active', reportCount: 0 })
    await service.transition('two', 1, 'coding', 'start', 'claim-two')
    // A new process has no remembered routes.
    const restarted = createAgentTasks(api, baseScope)
    expect(await restarted.report('one', structured, 'handoff', firstRunId)).toMatchObject({ report: { runId: firstRunId, sequence: 1 } })
    expect(await restarted.report('one', { message: 'Plan' }, 'plain')).toMatchObject({ comment: { id: 'comment' } })
    expect(fences.at(-1)).toEqual({ agentInstanceId: 'instance-a' })
    // Without its runId, a structured retry cannot be redirected and is rejected without saving.
    await expect(createAgentTasks(api, baseScope).report('one', structured, 'handoff')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(reports).toEqual([{ runId: firstRunId, ...structured }])
    expect(notes).toEqual(['[test-agent]\n\nPlan', '[test-agent]\n\nReady'])
    // Structured fields added to a remembered plain message are rejected, not dropped.
    await expect(restarted.report('one', { message: 'Plan', changedFileCount: 1 }, 'plain')).rejects.toMatchObject({ code: 'agent_run_not_active' })
    // A transient failure of the fallback keeps the comment route for the next retry.
    let failComment = false
    const flaky = fixture([task()])
    const flakyApi: typeof flaky.api = { ...flaky.api, async comment(...args) {
      if (failComment) { failComment = false; throw new AgentTaskError('unavailable', 'Try again', true) }
      return flaky.api.comment(...args)
    } }
    const before = createAgentTasks(flakyApi, baseScope)
    await before.report('one', { message: 'Plan' }, 'plain')
    await before.transition('one', 1, 'coding', 'start', 'claim')
    const after = createAgentTasks(flakyApi, baseScope)
    failComment = true
    await expect(after.report('one', { message: 'Plan' }, 'plain')).rejects.toMatchObject({ code: 'unavailable' })
    expect(await after.report('one', { message: 'Plan' }, 'plain')).toMatchObject({ comment: { id: 'comment' } })
    expect(flaky.notes).toEqual(['[test-agent]\n\nPlan'])
    // The same request still in progress is not redirected to the comment endpoint.
    const busy = fixture([task()], { async reportRun() { throw new AgentTaskError('idempotency_conflict', 'In progress', true) } })
    await busy.service.transition('one', 1, 'coding', 'start', 'claim')
    await expect(busy.service.report('one', { message: 'Plan' }, 'busy')).rejects.toMatchObject({ code: 'idempotency_conflict', retryable: true })
    expect(busy.notes).toEqual([])
    // A run of another task is refused before anything is sent.
    await expect(restarted.report('two', { message: 'Wrong' }, 'wrong', secondRunId)).rejects.toMatchObject({ code: 'run_task_mismatch' })
  })

  test('records progress separately, completes, reopens, and cancels using custom status IDs', async () => {
    const { service, records, notes } = fixture()
    await service.transition('one', 1, 'coding', 'start', 'a')
    await service.report('one', { message: 'Tests passed. PR: https://example.test/pr/1' }, 'note')
    expect(records.get('one')?.description).toBe('Original instructions')
    expect(notes).toEqual(['[test-agent]\n\nTests passed. PR: https://example.test/pr/1'])
    await service.transition('one', 2, 'review', 'move', 'b')
    expect(await service.transition('one', 3, 'shipped', 'complete', 'c')).toMatchObject({ statusCategory: 'completed' })
    expect(await service.transition('one', 4, 'todo', 'reopen', 'd')).toMatchObject({ statusCategory: 'unstarted' })
    expect(await service.transition('one', 5, 'canceled', 'cancel', 'e')).toMatchObject({ statusCategory: 'canceled' })
    expect(await service.next({})).toMatchObject({ action: 'none', task: null })
  })

  test('rejects a future revision before a concurrent writer could make its CAS valid', async () => {
    let writes = 0
    const { service } = fixture([task('one', { relationIds: ['blockedBy:missing'] })], {
      async update() { writes += 1; return task('one', { revision: 3, statusCategory: 'started' }) },
    })
    await expect(service.transition('one', 2, 'coding', 'start', 'future')).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.update('one', { expectedRevision: 2, title: 'Overwrite' }, 'future')).rejects.toMatchObject({ code: 'conflict' })
    expect(writes).toBe(0)
  })

  test('replays stale metadata updates and forwards comment scope to the canonical API', async () => {
    const { service } = fixture()
    expect(await service.update('one', { expectedRevision: 1, title: 'New' }, 'edit')).toMatchObject({ revision: 2 })
    expect(await service.update('one', { expectedRevision: 1, title: 'New' }, 'edit')).toMatchObject({ revision: 2 })
    const { api } = fixture([task('one', { assignedProjectId: 'project' })], {
      async catalog(project) { expect(project).toBe('project'); return catalog },
      async comments(_id, _cursor, _limit, project) {
        expect(project).toBe('project')
        return { items: [], hasMore: false }
      },
      async comment(_id, body, _key, project, assignee) {
        expect(project).toBe('project')
        expect(assignee).toBe('agent-member')
        return { id: 'comment', actorUserId: 'member', body, createdAt: '2026-09-01T00:00:00.000Z' }
      },
    })
    const reportRun = api.reportRun.bind(api)
    const reportedProjects: (string | undefined)[] = []
    /**
     * Records the Project a report is restricted to.
     *
     * @param runId - Reporting run.
     * @param instanceId - Instance that started the run.
     * @param input - Report fields.
     * @param key - Idempotency key.
     * @param project - Requested Project.
     * @returns The saved report.
     */
    api.reportRun = async (runId, instanceId, input, key, project) => {
      reportedProjects.push(project)
      return reportRun(runId, instanceId, input, key, project)
    }
    const scoped = createAgentTasks(api, { ...baseScope, agentName: 'test', assignedProjectId: 'project' })
    await scoped.configuration()
    // Without a run, a plain report is a comment scoped like every other request.
    await scoped.report('one', { message: 'Before starting' }, 'early-note')
    await scoped.transition('one', 1, 'coding', 'start', 'claim')
    await scoped.comments('one')
    // With its run, the report is restricted to the configured Project on the server too.
    await scoped.report('one', { message: 'Started' }, 'late-note')
    expect(reportedProjects).toEqual(['project'])
  })

  test('keeps runs of tasks outside the configured Project out of selection, heartbeats, and finishing', async () => {
    const { service, api } = fixture([
      task('inside', { assignedProjectId: 'project' }),
      task('outside', { assignedProjectId: 'other-project' }),
    ])
    const claimed = await service.transition('outside', 1, 'coding', 'start', 'claim-outside')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    const scoped = createAgentTasks(api, { ...baseScope, assignedProjectId: 'project' })
    expect(await scoped.next({})).toMatchObject({ action: 'start', task: { id: 'inside' }, ownRuns: [], otherRuns: [] })
    await expect(scoped.heartbeat(runId)).rejects.toMatchObject({ code: 'out_of_scope' })
    await expect(scoped.finishRun(runId, 'paused', 'finish-outside')).rejects.toMatchObject({ code: 'out_of_scope' })
  })

  test('keeps a run it just started out of ownRuns once its task leaves the configured Project', async () => {
    let moved = false
    const { api } = fixture([task('inside', { assignedProjectId: 'project' })])
    const lagging = createAgentTasks({
      ...api,
      async get(id) {
        const current = await api.get(id)
        return moved ? { ...current, assignedProjectId: 'other-project' } : current
      },
      /**
       * Lists the queue without tasks the test moved out of the Project.
       *
       * @param filters - Queue filters.
       * @param cursor - Continuation.
       * @param limit - Page size.
       * @returns One queue page.
       */
      async list(filters, cursor, limit) {
        // The server filters by Project, so a moved task leaves the scoped queue.
        const page = await api.list(filters, cursor, limit)
        return moved ? { ...page, items: page.items.filter((item) => item.id !== 'inside') } : page
      },
      /**
       * Simulates a run index that has not shown any run yet.
       *
       * @returns An empty page.
       */
      async listActiveRuns() {
        return { items: [], hasMore: false }
      },
    }, { ...baseScope, assignedProjectId: 'project' })
    const claimed = await lagging.transition('inside', 1, 'coding', 'start', 'claim-inside')
    const runId = 'run' in claimed ? claimed.run.runId : ''
    expect(await lagging.next({})).toMatchObject({ ownRuns: [{ runId }] })
    moved = true
    expect(await lagging.next({})).toMatchObject({ ownRuns: [] })
  })

  test('rejects blockers, inaccessible blockers, wrong assignment, invalid transitions, and Project escapes', async () => {
    const { service, api } = fixture([task('blocked', { relationIds: ['blockedBy:missing'] }), task('other', { assigneeUserId: 'someone-else' })])
    await expect(service.transition('blocked', 1, 'coding', 'start', 'a')).rejects.toMatchObject({ code: 'blocked' })
    await expect(service.transition('other', 1, 'coding', 'start', 'a')).rejects.toMatchObject({ code: 'not_assigned' })
    await expect(service.transition('blocked', 1, 'todo', 'start', 'a')).rejects.toMatchObject({ code: 'invalid_status' })
    const scoped = createAgentTasks(api, { ...baseScope, agentName: 'test', assignedProjectId: 'restricted-project' })
    await expect(scoped.get('blocked')).rejects.toMatchObject({ code: 'out_of_scope' })
    await expect(scoped.next({ assignedProjectId: 'different' })).rejects.toMatchObject({ code: 'out_of_scope' })
  })

  test('does not treat permission failures, partial scans, or repeated cursors as no work', async () => {
    const failed = fixture([], { async list() { throw new AgentTaskError('forbidden', 'Denied') } })
    await expect(failed.service.next({})).rejects.toMatchObject({ code: 'forbidden' })
    const repeated = fixture([], { async list() { return { items: [], hasMore: true, nextCursor: 'same' } } })
    await expect(repeated.service.next({})).rejects.toMatchObject({ code: 'invalid_response' })
    let count = 0
    const endless = fixture([], { async list() { return { items: [], hasMore: true, nextCursor: String(++count) } } })
    await expect(endless.service.next({})).rejects.toMatchObject({ code: 'queue_limit' })
    expect(count).toBe(20)
  })

  test('accepts only completed dependencies and surfaces dependency service failures', async () => {
    const { service } = fixture([task('one', { relationIds: ['blockedBy:dep'] }), task('dep', { statusCategory: 'completed' })])
    expect(await service.transition('one', 1, 'coding', 'start', 'a')).toMatchObject({ task: { statusCategory: 'started' } })
    const failure = fixture([task()], { async get() { throw new AgentTaskError('unavailable', 'Down', true) } })
    await expect(failure.service.get('one')).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('treats an accessible completed blocker outside the configured Project as unresolved', async () => {
    for (const assignedProjectId of ['project', 'outside']) {
      const { api } = fixture([
        task('one', { assignedProjectId: 'project', relationIds: ['blockedBy:dep'] }),
        task('dep', { assignedProjectId, assigneeUserId: 'another-member', statusCategory: 'completed' }),
      ])
      const service = createAgentTasks(api, { ...baseScope, agentName: 'test', assignedProjectId: 'project' })
      const blocked = assignedProjectId !== 'project'
      expect(await service.get('one')).toMatchObject({ blockers: { unresolvedCount: blocked ? 1 : 0 } })
      expect(await service.next({})).toMatchObject({ action: blocked ? 'none' : 'start', blockedCount: blocked ? 1 : 0 })
      if (blocked) {
        await expect(service.transition('one', 1, 'coding', 'start', 'claim')).rejects.toMatchObject({ code: 'blocked' })
      } else {
        expect(await service.transition('one', 1, 'coding', 'start', 'claim')).toMatchObject({ task: { statusCategory: 'started' } })
      }
    }
  })
})
