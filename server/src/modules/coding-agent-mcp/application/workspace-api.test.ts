import { expect, test } from 'bun:test'
import { createWorkItemTitleMatcher } from '@mukuroji/contracts'
import { AgentTaskError, type AgentTask } from './work-item-api'
import { createWorkspaceIssues, type WorkspaceApi } from './workspace-api'

/** Creates a minimal validated canonical Work Item. */
function task(patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task', teamId: 'team', revision: 3, title: 'Saved', description: '',
    assigneeUserId: 'owner', workflowStatusId: 'todo', statusCategory: 'unstarted',
    priority: 'medium', dueDate: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
    relationIds: [], customFieldValues: {}, ...patch,
  }
}

/**
 * Builds a Workspace API whose writes succeed and whose key read fails, as after a timeout.
 * @returns The API and the writes it received.
 */
function apiWithFailingKeyRead() {
  const writes: string[] = []
  const unexpected = () => { throw new Error('not used in this test') }
  const api: WorkspaceApi = {
    me: async () => ({ schemaVersion: 1, workspaceId: 'workspace', memberId: 'owner', email: 'owner@example.com' }),
    teams: unexpected,
    projectMembers: unexpected,
    projectCharter: unexpected,
    lookupKey: async (key) => ({ schemaVersion: 1, key, teamId: 'team', workItemId: 'task' }),
    catalog: unexpected,
    listIssues: unexpected,
    getIssue: unexpected,
    getKey: async () => { throw new AgentTaskError('unavailable', 'The key endpoint timed out.') },
    comments: unexpected,
    createIssue: async (input, key) => { writes.push(`create:${key}`); return task({ title: input.title }) },
    updateIssue: async (_teamId, _workItemId, input, key) => { writes.push(`update:${key}`); return task({ revision: input.expectedRevision + 1 }) },
    addComment: unexpected,
    hierarchy: unexpected,
    relations: unexpected,
    createRelation: unexpected,
    deleteRelation: unexpected,
    reserveSubtaskBatch: unexpected,
  }
  return { api, writes }
}

/**
 * Builds a Workspace API that records relation and subtask writes, failing the first parent link
 * of the second subtask once, as after a timeout.
 * @returns The API and the writes it received.
 */
function apiForRelations() {
  const writes: string[] = []
  const created = new Map<string, AgentTask>()
  const batches = new Map<string, string>()
  let failedOnce = false
  const { api: base } = apiWithFailingKeyRead()
  const api: WorkspaceApi = {
    ...base,
    getKey: async () => undefined,
    lookupKey: async (key) => ({ schemaVersion: 1, key, teamId: 'team', workItemId: key === 'ABC-1' ? 'parent' : 'other' }),
    getIssue: async (_teamId, workItemId) => task({ id: workItemId, assignedProjectId: 'web' }),
    createIssue: async (input, key) => {
      writes.push(`create:${key}:${input.title}:${input.assignedProjectId}:${input.assigneeUserId}`)
      const child = created.get(key) ?? task({ id: `child-${created.size + 1}`, title: input.title })
      created.set(key, child)
      return child
    },
    createRelation: async (teamId, workItemId, input, key) => {
      if (key.endsWith('.subtask.1.parent') && !failedOnce) {
        failedOnce = true
        throw new AgentTaskError('transport', 'The API request failed or timed out.', true)
      }
      writes.push(`link:${key}:${workItemId}:${input.type}:${input.targetWorkItemId}`)
      return { schemaVersion: 1, teamId, workItemId, relation: { type: input.type, targetWorkItemId: input.targetWorkItemId } }
    },
    deleteRelation: async (teamId, workItemId, targetWorkItemId, type, key) => {
      writes.push(`unlink:${key}:${workItemId}:${type}:${targetWorkItemId}`)
      return { schemaVersion: 1, teamId, workItemId, relation: { type, targetWorkItemId } }
    },
    reserveSubtaskBatch: async (teamId, workItemId, input, key) => {
      // Like the Public API, the same key replays only the same parent and list.
      const fingerprint = JSON.stringify({ workItemId, input })
      if ((batches.get(key) ?? fingerprint) !== fingerprint) {
        throw new AgentTaskError('idempotency_conflict', 'The key was used with another request.', false)
      }
      batches.set(key, fingerprint)
      writes.push(`batch:${key}:${input.subtasks.map((subtask) => subtask.title).join(',')}`)
      return { schemaVersion: 1, teamId, workItemId, subtaskCount: input.subtasks.length }
    },
    hierarchy: async (teamId, workItemId) => ({
      schemaVersion: 1, teamId, workItemId, parentWorkItemId: null, childWorkItemIds: ['child-1'], wbsNumber: '2',
    }),
    relations: async (teamId, workItemId) => ({
      schemaVersion: 1, teamId, workItemId, relations: [{ type: 'blockedBy', targetWorkItemId: 'other' }],
    }),
  }
  return { api, writes }
}

test('create_subtasks puts each child under the parent in its Project and finishes on a retry without duplicates', async () => {
  const { api, writes } = apiForRelations()
  const issues = createWorkspaceIssues(api)
  const input = {
    parentId: 'ABC-1',
    subtasks: [{ title: 'Design' }, { title: 'Build', assigneeId: 'member-2' }],
    idempotencyKey: 'split-key',
  }

  await expect(issues.createSubtasks(input)).rejects.toMatchObject({
    code: 'transport', retryable: true, message: expect.stringContaining('Subtasks 1 to 1 were created'),
  })
  const done = await issues.createSubtasks(input)

  expect(done).toEqual({
    teamId: 'team', workItemId: 'parent', subtasks: [{ id: 'child-1', title: 'Design' }, { id: 'child-2', title: 'Build' }],
  })
  expect(writes).toEqual([
    'batch:split-key.batch:Design,Build',
    'create:split-key.subtask.0:Design:web:owner',
    'link:split-key.subtask.0.parent:child-1:parent:parent',
    'create:split-key.subtask.1:Build:web:member-2',
    'batch:split-key.batch:Design,Build',
    'create:split-key.subtask.0:Design:web:owner',
    'link:split-key.subtask.0.parent:child-1:parent:parent',
    'create:split-key.subtask.1:Build:web:member-2',
    'link:split-key.subtask.1.parent:child-2:parent:parent',
  ])
  await expect(issues.createSubtasks({ ...input, subtasks: [] })).rejects.toMatchObject({ code: 'invalid_request' })
})

test('create_subtasks refuses the same key with another list before creating any subtask', async () => {
  const { api, writes } = apiForRelations()
  const issues = createWorkspaceIssues(api)
  await issues.createSubtasks({ parentId: 'ABC-1', subtasks: [{ title: 'Design' }], idempotencyKey: 'grow' })
  writes.length = 0

  await expect(issues.createSubtasks({ parentId: 'ABC-1', subtasks: [{ title: 'Design' }, { title: 'Build' }], idempotencyKey: 'grow' }))
    .rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      message: expect.stringContaining('No subtask was created.'),
    })
  expect(writes).toEqual([])
})

test('create_subtasks names a created Work Item whose parent link failed and how to recover', async () => {
  const { api } = apiForRelations()
  const issues = createWorkspaceIssues({
    ...api,
    createRelation: async () => { throw new AgentTaskError('conflict', 'The relation was rejected.') },
  })

  await expect(issues.createSubtasks({ parentId: 'ABC-1', subtasks: [{ title: 'Design' }], idempotencyKey: 'link-fails' }))
    .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Work Item child-1 was created but is not linked to the parent yet; if its Type is not allowed under the parent, change it with save_issue and retry.') })
})

test('create_subtasks explains a replay conflict after the parent moved to another Project', async () => {
  const { api } = apiForRelations()
  const issues = createWorkspaceIssues({
    ...api,
    createIssue: async () => { throw new AgentTaskError('idempotency_conflict', 'Different request', false) },
  })

  await expect(issues.createSubtasks({ parentId: 'ABC-1', subtasks: [{ title: 'Design' }], idempotencyKey: 'moved' }))
    .rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      message: expect.stringContaining("the parent's Project (or this subtask's arguments) has changed since then. Move the parent back to its earlier Project"),
    })
})

test('create_subtasks keeps same-key retry guidance while a child creation is still in progress', async () => {
  const { api } = apiForRelations()
  const issues = createWorkspaceIssues({
    ...api,
    createIssue: async () => { throw new AgentTaskError('idempotency_conflict', 'The same request is still running.', true) },
  })

  const failure = issues.createSubtasks({ parentId: 'ABC-1', subtasks: [{ title: 'Design' }], idempotencyKey: 'running' })
  await expect(failure).rejects.toMatchObject({
    code: 'idempotency_conflict',
    retryable: true,
    message: expect.stringContaining('Retry with the same arguments and idempotencyKey to finish without duplicates.'),
  })
  await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining("Project (or this subtask's arguments)") })
})

test('save_relation links and unlinks by key, and list_relations combines the tree with the other links', async () => {
  const { api, writes } = apiForRelations()
  const issues = createWorkspaceIssues(api)

  expect(await issues.saveRelation({ issueId: 'ABC-1', type: 'blockedBy', relatedIssueId: 'ABC-2', idempotencyKey: 'link-key' }))
    .toEqual({ teamId: 'team', workItemId: 'parent', removed: false, relation: { type: 'blockedBy', relatedIssueId: 'other' } })
  await issues.saveRelation({ issueId: 'ABC-1', type: 'related', relatedIssueId: 'ABC-2', remove: true, idempotencyKey: 'unlink-key' })
  expect(writes).toEqual(['link:link-key:parent:blockedBy:other', 'unlink:unlink-key:parent:related:other'])
  expect(await issues.listRelations('ABC-1')).toEqual({
    teamId: 'team', workItemId: 'parent', parentId: null, childIds: ['child-1'], wbsNumber: '2',
    relations: [{ type: 'blockedBy', relatedIssueId: 'other' }],
  })
})

test('save_issue returns the saved Work Item with a warning when the key cannot be read afterwards', async () => {
  const { api, writes } = apiWithFailingKeyRead()
  const issues = createWorkspaceIssues(api)

  const created = await issues.saveIssue({ teamId: 'team', title: 'New', idempotencyKey: 'create-key' })
  expect(created).toMatchObject({ id: 'task', title: 'New', warning: expect.stringContaining('get_issue') })
  expect(created).not.toHaveProperty('key')

  const updated = await issues.saveIssue({ id: 'ABC-1', expectedRevision: 3, priority: 'high', idempotencyKey: 'update-key' })
  expect(updated).toMatchObject({ id: 'task', revision: 4, warning: expect.stringContaining('get_issue') })
  expect(writes).toEqual(['create:create-key', 'update:update-key'])
})

/**
 * Builds a Workspace API with two readable Teams whose Work Item lists have the given pages.
 * @param pages - Pages per Team, in order; each page's cursor is its index.
 * @returns The API and the list calls it received.
 */
function apiWithTeams(pages: Record<string, AgentTask[][]>) {
  const calls: Array<{ teamId: string, query?: string, cursor?: string }> = []
  const { api: base } = apiWithFailingKeyRead()
  const api: WorkspaceApi = {
    ...base,
    teams: async () => ({
      schemaVersion: 1,
      items: [
        { id: 'alpha', name: 'Alpha', projects: [{ id: 'web', name: 'Web', lifecycleState: 'active' }] },
        { id: 'beta', name: 'Beta', projects: [{ id: 'web', name: 'Web too', lifecycleState: 'active' }, { id: 'ops', name: 'Ops', lifecycleState: 'active' }] },
      ],
    }),
    listIssues: async (teamId, filters, cursor) => {
      calls.push({ teamId, ...(filters.query === undefined ? {} : { query: filters.query }), ...(cursor === undefined ? {} : { cursor }) })
      const teamPages = pages[teamId] ?? [[]]
      const index = cursor === undefined ? 0 : Number(cursor)
      const hasMore = index + 1 < teamPages.length
      return { items: teamPages[index] ?? [], hasMore, ...(hasMore ? { nextCursor: String(index + 1) } : {}) }
    },
  }
  return { api, calls }
}

test('list_issues without a Team walks every readable Team with a cursor of its own', async () => {
  const { api, calls } = apiWithTeams({
    alpha: [[task({ id: 'a1', teamId: 'alpha', title: 'Fix login' })], [task({ id: 'a2', teamId: 'alpha', title: 'LOGIN copy' })]],
    // A server older than `query` returns every Work Item; the MCP keeps only the matching ones.
    beta: [[task({ id: 'b1', teamId: 'beta', title: 'Login timeout' }), task({ id: 'b2', teamId: 'beta', title: 'Billing' })]],
  })
  const issues = createWorkspaceIssues(api)
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = await issues.listIssues(undefined, { query: 'login' }, cursor)
    seen.push(...page.items.map((item) => item.id))
    cursor = page.nextCursor
    expect(page.hasMore).toBe(cursor !== undefined)
  } while (cursor !== undefined)

  expect(seen).toEqual(['a1', 'a2', 'b1'])
  expect(calls).toEqual([
    { teamId: 'alpha', query: 'login' },
    { teamId: 'alpha', query: 'login', cursor: '1' },
    { teamId: 'beta', query: 'login' },
  ])
})

test('list_issues without a Team refuses Team-scoped filters and foreign cursors', async () => {
  const issues = createWorkspaceIssues(apiWithTeams({}).api)
  for (const filters of [{ assignedProjectId: 'web' }, { workflowStatusId: 'todo' }, { workItemTypeId: 'bug' }]) {
    await expect(issues.listIssues(undefined, filters)).rejects.toMatchObject({ code: 'invalid_request' })
  }
  await expect(issues.listIssues(undefined, {}, 'server-cursor')).rejects.toMatchObject({ code: 'invalid_request' })
  const gone = `t1.${Buffer.from(JSON.stringify({ teamId: 'removed' })).toString('base64url')}`
  await expect(issues.listIssues(undefined, {}, gone)).rejects.toMatchObject({ code: 'invalid_request' })
})

test('get_project returns the charter, or the Project alone when the charter is not readable', async () => {
  const { api: base } = apiWithTeams({})
  const charters: string[] = []
  let charterError: AgentTaskError | undefined
  const api: WorkspaceApi = {
    ...base,
    projectCharter: async (teamId, projectId) => {
      charters.push(`${teamId}/${projectId}`)
      if (charterError) throw charterError
      return {
        schemaVersion: 1, teamId, projectId, lifecycleState: 'active', revision: 4,
        purpose: 'Run the service', tags: ['ops'], repositoryUrls: ['https://github.com/example/ops'],
      }
    },
  }
  const issues = createWorkspaceIssues(api)

  expect(await issues.getProject('ops')).toMatchObject({
    id: 'ops', teamId: 'beta', teamName: 'Beta', charterReadable: true, revision: 4, purpose: 'Run the service', tags: ['ops'],
  })
  await expect(issues.getProject('web')).rejects.toMatchObject({ code: 'invalid_request' })
  expect(await issues.getProject('web', 'alpha')).toMatchObject({ teamId: 'alpha', name: 'Web' })
  await expect(issues.getProject('missing')).rejects.toMatchObject({ code: 'not_found' })
  charterError = new AgentTaskError('forbidden', 'Guests cannot read charters.')
  expect(await issues.getProject('ops')).toEqual({ id: 'ops', name: 'Ops', lifecycleState: 'active', teamId: 'beta', teamName: 'Beta', charterReadable: false })
  charterError = new AgentTaskError('unavailable', 'Timed out.', true)
  await expect(issues.getProject('ops')).rejects.toMatchObject({ code: 'unavailable' })
  expect(charters).toEqual(['beta/ops', 'alpha/web', 'beta/ops', 'beta/ops'])
})

test('save_issue sends custom field values and refuses to clear one on a new Work Item', async () => {
  const sent: unknown[] = []
  const { api: base } = apiWithFailingKeyRead()
  const api: WorkspaceApi = {
    ...base,
    getKey: async () => undefined,
    createIssue: async (input) => { sent.push(input.customFieldValues); return task() },
    updateIssue: async (_teamId, _workItemId, input) => { sent.push(input.customFieldValues); return task() },
  }
  const issues = createWorkspaceIssues(api)
  const key = '00000000-0000-4000-8000-000000000001'

  await issues.saveIssue({ teamId: 'team', title: 'New', customFields: { severity: 'sev-1', labels: ['ui'] }, idempotencyKey: key })
  await issues.saveIssue({ id: 'task', teamId: 'team', expectedRevision: 3, customFields: { severity: null }, idempotencyKey: key })
  await expect(issues.saveIssue({ teamId: 'team', title: 'New', customFields: { severity: null }, idempotencyKey: key }))
    .rejects.toMatchObject({ code: 'invalid_request' })
  await expect(issues.saveIssue({ id: 'task', teamId: 'team', expectedRevision: 3, customFields: {}, idempotencyKey: key }))
    .rejects.toMatchObject({ code: 'invalid_request' })

  expect(sent).toEqual([{ severity: 'sev-1', labels: ['ui'] }, { severity: null }])
})

test('the title matcher needs every word regardless of case, width, and order', () => {
  const matches = createWorkItemTitleMatcher('ｌｏｇｉｎ　失敗')
  expect(matches('Login 時の認証失敗を直す')).toBe(true)
  expect(matches('失敗した LOGIN を再試行する')).toBe(true)
  expect(matches('Login 画面の文言')).toBe(false)
  expect(createWorkItemTitleMatcher('board')(' Onboarding を改善する')).toBe(true)
})
