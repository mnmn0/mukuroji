import { expect, test } from 'bun:test'
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
