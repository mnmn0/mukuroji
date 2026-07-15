import { afterEach, describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  getWorkspaceWorkItems,
  TeamIssuesApiError,
  updateTeamIssue,
} from '../src/issues/api'
import { getProjectTasks, ProjectTasksApiError } from '../src/tasks/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-1',
  idempotencyKey: 'idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('canonical Work Item API', () => {
  test('loads unassigned Work Items from the workspace-wide endpoint', async () => {
    const workItem = createWorkItem({ assignedProjectId: undefined })
    const requests = installFetchRecorder({ workItems: [workItem] })

    const result = await getWorkspaceWorkItems('access-token')

    expect(result).toEqual([workItem])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/work-items')
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('sends expectedRevision with stable mutation headers', async () => {
    const updatedWorkItem = createWorkItem({ revision: 4, workflowStatusId: 'done' })
    const requests = installFetchRecorder({ issue: updatedWorkItem })

    const result = await updateTeamIssue(
      'core team',
      'issue/1',
      'access-token',
      {
        expectedRevision: 3,
        workflowStatusId: 'done',
      },
      mutationContext,
    )

    expect(result).toEqual(updatedWorkItem)
    expect(requests[0]?.url).toBe('/api/teams/core%20team/issues/issue%2F1')
    expect(requests[0]?.init.method).toBe('PATCH')
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'idempotency-1',
      'X-Correlation-Id': 'correlation-1',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      expectedRevision: 3,
      workflowStatusId: 'done',
    })
  })

  test('preserves the stable revision conflict code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'WorkItemRevisionConflict',
      message: 'Work Item changed after it was loaded.',
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 409,
    })) as typeof fetch

    try {
      await updateTeamIssue(
        'core-team',
        'issue-1',
        'access-token',
        { expectedRevision: 1, workflowStatusId: 'review' },
        mutationContext,
      )
      throw new Error('Expected updateTeamIssue to reject.')
    } catch (error) {
      expect(error).toBeInstanceOf(TeamIssuesApiError)
      expect(error).toMatchObject({
        code: 'WorkItemRevisionConflict',
        status: 409,
      })
    }
  })

  test('uses readable fallback text for a non-JSON error response', async () => {
    globalThis.fetch = (async () => new Response('<html>Bad Gateway</html>', {
      headers: { 'Content-Type': 'text/html' },
      status: 502,
    })) as typeof fetch

    const error = await getWorkspaceWorkItems('access-token').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(TeamIssuesApiError)
    expect(error).toMatchObject({
      message: 'Unable to complete the Work Item request.',
      status: 502,
    })
  })

  test('uses readable fallback text when the JSON error message is invalid', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: '  ' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    })) as typeof fetch

    const error = await getWorkspaceWorkItems('access-token').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(TeamIssuesApiError)
    expect(error).toMatchObject({
      message: 'Unable to complete the Work Item request.',
      status: 500,
    })
  })
})

describe('read-only legacy Project task adapter', () => {
  test('accepts the exact legacy response shape without canonical fields', async () => {
    const task = {
      assignee: 'Demo User',
      dueDate: '2026/07/18',
      id: 'legacy-task-1',
      priority: 'medium',
      source: 'legacy',
      status: 'review',
      title: 'Legacy task',
    }
    const requests = installFetchRecorder({ projectId: 'legacy-project', tasks: [task] })

    await expect(getProjectTasks('legacy-project', 'access-token')).resolves.toEqual([task])
    expect(requests[0]?.url).toBe('/api/projects/legacy-project/tasks')
  })

  test('rejects a legacy response missing required adapter fields', async () => {
    installFetchRecorder({
      projectId: 'legacy-project',
      tasks: [{ id: 'legacy-task-1', source: 'legacy' }],
    })

    await expect(getProjectTasks('legacy-project')).rejects.toBeInstanceOf(ProjectTasksApiError)
  })
})

function createWorkItem(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 3,
    id: 'issue-1',
    teamId: 'core-team',
    title: 'Canonical Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    customFieldValues: {},
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
    dueDate: '2026/07/12',
    priority: 'medium',
    relationIds: [],
    source: 'dynamodb',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  }
}

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
