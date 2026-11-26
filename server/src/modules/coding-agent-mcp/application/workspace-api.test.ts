import { expect, test } from 'bun:test'
import { createWorkItemTitleMatcher } from '@mukuroji/contracts'
import { AgentTaskError, type AgentTask } from './work-item-api'
import type { PublicPlanningEntity } from '@mukuroji/contracts'
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
    webLinks: unexpected,
    createWebLink: unexpected,
    deleteWebLink: unexpected,
    planningEntities: unexpected,
    createMilestone: unexpected,
    updateMilestone: unexpected,
    workItemPlanning: unexpected,
    updateWorkItemPlanning: unexpected,
    statusUpdates: unexpected,
    publishStatusUpdate: unexpected,
    listDocuments: unexpected,
    workItemDocuments: unexpected,
    getDocument: unexpected,
    createDocument: unexpected,
    updateDocument: unexpected,
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

test('attachments resolve the key and shape the stored web links', async () => {
  const link = {
    id: 'a'.repeat(32), url: 'https://github.com/o/r/pull/1', title: 'PR', createdByMemberId: 'owner', createdAt: '2026-11-26T00:00:00.000Z',
  }
  const writes: string[] = []
  const { api: base } = apiWithFailingKeyRead()
  const issues = createWorkspaceIssues({
    ...base,
    webLinks: async (teamId, workItemId) => ({ schemaVersion: 1, teamId, workItemId, items: [link] }),
    createWebLink: async (teamId, workItemId, input, key) => {
      writes.push(`create:${teamId}:${workItemId}:${input.url}:${input.title ?? ''}:${key}`)
      return { schemaVersion: 1, teamId, workItemId, link: { ...link, url: input.url } }
    },
    deleteWebLink: async (teamId, workItemId, linkId, key) => {
      writes.push(`delete:${teamId}:${workItemId}:${linkId}:${key}`)
      return { schemaVersion: 1, teamId, workItemId, link }
    },
  })

  expect(await issues.listAttachments('ABC-1')).toEqual({
    teamId: 'team', workItemId: 'task',
    attachments: [{ id: link.id, url: link.url, title: 'PR', createdById: 'owner', createdAt: link.createdAt }],
  })
  const saved = await issues.saveAttachment({ issueId: 'ABC-1', url: 'https://example.com/doc', idempotencyKey: 'k1' })
  expect(saved.attachment.url).toBe('https://example.com/doc')
  const removed = await issues.deleteAttachment('ABC-1', undefined, link.id, 'k2')
  expect(removed.removed).toBe(true)
  expect(writes).toEqual([
    'create:team:task:https://example.com/doc::k1',
    `delete:team:task:${link.id}:k2`,
  ])
})

test('list_issues without a Team skips a Team whose Work Items are not readable and stops on other failures', async () => {
  const { api: base } = apiWithTeams({ beta: [[task({ id: 'b1', teamId: 'beta', title: 'Login timeout' })]] })
  const failing = (code: 'forbidden' | 'unavailable'): WorkspaceApi => ({
    ...base,
    listIssues: async (teamId, filters, cursor) => {
      if (teamId === 'alpha') throw new AgentTaskError(code, 'Team alpha failed.')
      return base.listIssues(teamId, filters, cursor)
    },
  })

  const issues = createWorkspaceIssues(failing('forbidden'))
  const first = await issues.listIssues(undefined, {})
  expect(first.items).toEqual([])
  expect(first.hasMore).toBe(true)
  const second = await issues.listIssues(undefined, {}, first.nextCursor)
  expect(second.items.map((item) => item.id)).toEqual(['b1'])
  expect(second.hasMore).toBe(false)

  await expect(createWorkspaceIssues(failing('unavailable')).listIssues(undefined, {})).rejects.toMatchObject({ code: 'unavailable' })
})

/** Creates a Milestone as the Public API returns it. */
function milestone(patch: Partial<PublicPlanningEntity> = {}): PublicPlanningEntity {
  return {
    id: 'ms-1', type: 'milestone', title: 'Beta', ownerMemberId: 'owner', status: 'planned', health: 'unknown', risk: 'none',
    progress: 0, linkedWorkItemCount: 0,
    baseline: { startDate: '2026-12-01', endDate: '2026-12-10' }, forecast: { startDate: '2026-12-01', endDate: '2026-12-10' },
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...patch,
  }
}

/**
 * Builds a Workspace API that records Planning writes.
 * @returns The API and the writes it received.
 */
function apiForPlanning() {
  const writes: Array<{ call: string, input: unknown, key?: string }> = []
  const { api: base } = apiWithFailingKeyRead()
  const api: WorkspaceApi = {
    ...base,
    getKey: async () => 'ABC-1',
    getIssue: async (_teamId, workItemId) => task({ id: workItemId }),
    planningEntities: async () => ({ schemaVersion: 1, revision: 7, items: [milestone()] }),
    createMilestone: async (input, key) => {
      writes.push({ call: 'createMilestone', input, key })
      return { schemaVersion: 1, revision: 8, item: milestone({ title: input.title }) }
    },
    updateMilestone: async (milestoneId, input, key) => {
      writes.push({ call: 'updateMilestone', input, key })
      return { schemaVersion: 1, revision: 8, item: milestone({ id: milestoneId }) }
    },
    updateWorkItemPlanning: async (teamId, workItemId, input, key) => {
      writes.push({ call: 'updateWorkItemPlanning', input, key })
      return {
        schemaVersion: 1, revision: 9, teamId, workItemId, goalIds: [],
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
      }
    },
    publishStatusUpdate: async (input, key) => {
      writes.push({ call: 'publishStatusUpdate', input, key })
      return {
        schemaVersion: 1, revision: 10,
        item: {
          id: 'pu-1', version: 1, target: input.target, health: input.health, risk: input.risk ?? 'none', summary: input.summary,
          riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '', progress: { percent: 0, linkedWorkItemCount: 0 },
          authorMemberId: 'owner', coveredDueAt: '2026-11-27T00:00:00.000Z', createdAt: '2026-11-26T00:00:00.000Z',
        },
      }
    },
  }
  return { api, writes }
}

test('save_milestone creates a Milestone from a target date, owned by me by default', async () => {
  const { api, writes } = apiForPlanning()
  const saved = await createWorkspaceIssues(api).saveMilestone({
    title: 'Beta', parentId: 'initiative', teamId: 'team', targetDate: '2026-12-10', ownerId: 'me', idempotencyKey: 'key-1',
  })
  expect(saved.item.title).toBe('Beta')
  expect(writes).toEqual([{
    call: 'createMilestone',
    input: { title: 'Beta', parentId: 'initiative', teamId: 'team', ownerMemberId: 'owner', targetDate: '2026-12-10' },
    key: 'key-1',
  }])
})

test('save_milestone changes only the fields passed', async () => {
  const { api, writes } = apiForPlanning()
  await createWorkspaceIssues(api).saveMilestone({ id: 'ms-1', targetDate: '2026-12-20', health: 'at-risk', idempotencyKey: 'key-2' })
  expect(writes).toEqual([{ call: 'updateMilestone', input: { health: 'at-risk', targetDate: '2026-12-20' }, key: 'key-2' }])
})

test('save_milestone refuses creation-only fields on an update and an empty update', async () => {
  const { api, writes } = apiForPlanning()
  const issues = createWorkspaceIssues(api)
  await expect(issues.saveMilestone({ id: 'ms-1', teamId: 'team', idempotencyKey: 'key-3' })).rejects.toThrow('only when creating')
  await expect(issues.saveMilestone({ id: 'ms-1', expectedRevision: 3, idempotencyKey: 'key-4' })).rejects.toThrow('at least one field')
  await expect(issues.saveMilestone({ title: 'No date', parentId: 'initiative', idempotencyKey: 'key-5' })).rejects.toThrow('targetDate')
  await expect(issues.saveMilestone({ title: 'No parent', targetDate: '2026-12-10', idempotencyKey: 'key-5' })).rejects.toThrow('parentId')
  expect(writes).toEqual([])
})

test('save_issue puts a new Work Item in a Cycle with a key derived from the call', async () => {
  const { api, writes } = apiForPlanning()
  const saved = await createWorkspaceIssues(api).saveIssue({ teamId: 'team', title: 'Ship', cycleId: 'cycle-1', idempotencyKey: 'key-6' })
  expect(saved).toMatchObject({ key: 'ABC-1', cycleId: 'cycle-1' })
  expect(writes).toEqual([{ call: 'updateWorkItemPlanning', input: { cycleId: 'cycle-1' }, key: 'key-6.planning' }])
})

test('save_issue changes only the Milestone without a Work Item revision', async () => {
  const { api, writes } = apiForPlanning()
  const saved = await createWorkspaceIssues(api).saveIssue({ id: 'ABC-1', milestoneId: null, idempotencyKey: 'key-7' })
  expect(saved).toMatchObject({ id: 'task', key: 'ABC-1' })
  expect(writes).toEqual([{ call: 'updateWorkItemPlanning', input: { milestoneId: null }, key: 'key-7.planning' }])
})

test('save_issue reports a saved Work Item whose Cycle could not be set, so a retry finishes it', async () => {
  const { api: base, writes } = apiForPlanning()
  const { api: issueApi, writes: issueWrites } = apiWithFailingKeyRead()
  let failures = 1
  const api: WorkspaceApi = {
    ...base,
    createIssue: issueApi.createIssue,
    updateWorkItemPlanning: async (...args) => {
      if (failures-- > 0) throw new AgentTaskError('conflict', 'Planning changed.', false)
      return base.updateWorkItemPlanning(...args)
    },
  }
  const issues = createWorkspaceIssues(api)
  const input = { teamId: 'team', title: 'Ship', cycleId: 'cycle-1', idempotencyKey: 'key-8' }
  await expect(issues.saveIssue(input)).rejects.toThrow('Work Item task was saved, but its Cycle or Milestone was not changed')

  // The retry sends the same key, which the server replays for the Work Item, and finishes the link.
  const saved = await issues.saveIssue(input)
  expect(saved).toMatchObject({ cycleId: 'cycle-1' })
  expect(issueWrites).toEqual(['create:key-8', 'create:key-8'])
  expect(writes).toEqual([{ call: 'updateWorkItemPlanning', input: { cycleId: 'cycle-1' }, key: 'key-8.planning' }])
})

test('save_status_update publishes the update without the idempotency key in the body', async () => {
  const { api, writes } = apiForPlanning()
  const target = { type: 'project' as const, teamId: 'team', projectId: 'web' }
  const saved = await createWorkspaceIssues(api).saveStatusUpdate({ target, health: 'on-track', summary: 'On plan.', idempotencyKey: 'key-9' })
  expect(saved.item.target).toEqual(target)
  expect(writes).toEqual([{ call: 'publishStatusUpdate', input: { target, health: 'on-track', summary: 'On plan.' }, key: 'key-9' }])
})

test('save_document creates a page linked to a Work Item by key and updates it with the expected revision', async () => {
  const calls: string[] = []
  const { api: base } = apiWithFailingKeyRead()
  const issues = createWorkspaceIssues({
    ...base,
    createDocument: async (input, key) => { calls.push(`create:${key}:${JSON.stringify(input)}`); return { id: 'doc-1', kind: 'page', title: 'Plan', scope: { type: 'workspace' }, revision: 1 } },
    updateDocument: async (documentId, input, key) => { calls.push(`update:${key}:${documentId}:${JSON.stringify(input)}`); return { id: documentId, kind: 'page', title: 'Plan', scope: { type: 'workspace' }, revision: 2 } },
  })

  expect(await issues.saveDocument({ title: 'Plan', content: '# Plan', projectId: 'web', issueId: 'ABC-1', idempotencyKey: 'k1' }))
    .toMatchObject({ id: 'doc-1', revision: 1 })
  expect(await issues.saveDocument({ id: 'doc-1', content: 'New', expectedRevision: 1, idempotencyKey: 'k2' }))
    .toMatchObject({ id: 'doc-1', revision: 2 })
  expect(calls).toEqual([
    `create:k1:${JSON.stringify({ title: 'Plan', content: '# Plan', projectId: 'web', workItem: { teamId: 'team', workItemId: 'task' } })}`,
    `update:k2:doc-1:${JSON.stringify({ expectedRevision: 1, content: 'New' })}`,
  ])
  await expect(issues.saveDocument({ title: 'Plan', idempotencyKey: 'k3' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(issues.saveDocument({ id: 'doc-1', title: 'Plan', idempotencyKey: 'k4' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(issues.saveDocument({ id: 'doc-1', expectedRevision: 2, idempotencyKey: 'k5' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(issues.saveDocument({ id: 'doc-1', expectedRevision: 2, title: 'Plan', projectId: 'web', idempotencyKey: 'k6' }))
    .rejects.toMatchObject({ code: 'invalid_request' })
  expect(calls).toHaveLength(2)
})

test('list_documents lists the Workspace with filters, or the Documents linked to a Work Item', async () => {
  const calls: string[] = []
  const { api: base } = apiWithFailingKeyRead()
  const issues = createWorkspaceIssues({
    ...base,
    listDocuments: async (filters, cursor, limit) => { calls.push(`workspace:${JSON.stringify(filters)}:${cursor}:${limit}`); return { items: [], hasMore: false } },
    workItemDocuments: async (teamId, workItemId) => { calls.push(`linked:${teamId}/${workItemId}`); return { items: [{ id: 'doc-1', title: 'Spec' }], hasMore: false } },
  })

  await issues.listDocuments({ projectId: 'web', cursor: 'c', limit: 10 })
  expect(await issues.listDocuments({ issueId: 'ABC-1' })).toEqual({
    teamId: 'team', workItemId: 'task', items: [{ id: 'doc-1', title: 'Spec' }], hasMore: false,
  })
  await expect(issues.listDocuments({ issueId: 'ABC-1', projectId: 'web' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(issues.listDocuments({ teamId: 'team' })).rejects.toMatchObject({ code: 'invalid_request' })
  expect(calls).toEqual(['workspace:{"projectId":"web"}:c:10', 'linked:team/task'])
})
