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
  }
  return { api, writes }
}

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
