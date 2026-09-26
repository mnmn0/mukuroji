import { describe, expect, test } from 'bun:test'
import { createAgentTasks } from './agent-tasks'
import { AgentTaskError, type AgentCatalog, type AgentTask, type AgentWorkItemApi } from './work-item-api'

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

/** Builds an in-memory CAS API with durable mutation receipts for lifecycle tests. */
function fixture(initial: AgentTask[] = [task()], overrides: Partial<AgentWorkItemApi> = {}) {
  const records = new Map(initial.map((item) => [item.id, structuredClone(item)]))
  const receipts = new Map<string, { fingerprint: string; task: AgentTask }>()
  const notes: string[] = []
  const api: AgentWorkItemApi = {
    async catalog() { return catalog },
    async get(id) {
      const found = records.get(id)
      if (!found) throw new AgentTaskError('not_found', 'Not found')
      return structuredClone(found)
    },
    async list(filters) { return { items: [...records.values()].filter((item) => !filters.assigneeUserId || item.assigneeUserId === filters.assigneeUserId), hasMore: false } },
    async create(input) {
      const created = task('created', input)
      records.set(created.id, created)
      return created
    },
    async update(id, input, key) {
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
    async comment(_id, body) {
      notes.push(body)
      return { id: 'comment', actorUserId: 'agent-member', body, createdAt: '2026-09-01T00:00:00.000Z' }
    },
    ...overrides,
  }
  return { api, records, notes, service: createAgentTasks(api, { assigneeUserId: 'agent-member', agentName: 'test-agent' }) }
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

  test('reports started work before selecting new work without granting another claim, and counts all statuses', async () => {
    const { service } = fixture([task('ready', { priority: 'high' }), task('active', { workflowStatusId: 'coding', statusCategory: 'started' }), task('done', { statusCategory: 'completed' })])
    expect(await service.next({})).toMatchObject({ action: 'in_progress', task: { id: 'active' } })
    expect(await service.status({})).toMatchObject({ total: 3, counts: { started: 1, unstarted: 1, completed: 1 } })
  })

  test('only one concurrent claimant succeeds; identical uncertain retries replay, changed keys conflict', async () => {
    const { service } = fixture()
    const claims = await Promise.allSettled([
      service.transition('one', 1, 'coding', 'start', 'claim-a'),
      service.transition('one', 1, 'coding', 'start', 'claim-b'),
    ])
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    expect(await service.transition('one', 1, 'coding', 'start', 'claim-a')).toMatchObject({ revision: 2, statusCategory: 'started' })
    await expect(service.transition('one', 1, 'review', 'start', 'claim-a')).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.transition('one', 2, 'coding', 'start', 'new-claim')).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  test('records progress separately, completes, reopens, and cancels using custom status IDs', async () => {
    const { service, records, notes } = fixture()
    await service.transition('one', 1, 'coding', 'start', 'a')
    await service.report('one', 'Tests passed. PR: https://example.test/pr/1', 'note')
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
    const scoped = createAgentTasks(api, { agentName: 'test', assigneeUserId: 'agent-member', assignedProjectId: 'project' })
    await scoped.comments('one')
    await scoped.report('one', 'Progress', 'note')
  })

  test('rejects blockers, inaccessible blockers, wrong assignment, invalid transitions, and Project escapes', async () => {
    const { service, api } = fixture([task('blocked', { relationIds: ['blockedBy:missing'] }), task('other', { assigneeUserId: 'someone-else' })])
    await expect(service.transition('blocked', 1, 'coding', 'start', 'a')).rejects.toMatchObject({ code: 'blocked' })
    await expect(service.transition('other', 1, 'coding', 'start', 'a')).rejects.toMatchObject({ code: 'not_assigned' })
    await expect(service.transition('blocked', 1, 'todo', 'start', 'a')).rejects.toMatchObject({ code: 'invalid_status' })
    const scoped = createAgentTasks(api, { agentName: 'test', assigneeUserId: 'agent-member', assignedProjectId: 'restricted-project' })
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
    expect(await service.transition('one', 1, 'coding', 'start', 'a')).toMatchObject({ statusCategory: 'started' })
    const failure = fixture([task()], { async get() { throw new AgentTaskError('unavailable', 'Down', true) } })
    await expect(failure.service.get('one')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
