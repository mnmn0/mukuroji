import { afterEach, describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type WorkItemSchedule,
  type WorkItemScheduleImpact,
} from '@mukuroji/contracts'
import {
  confirmTeamIssueSchedule,
  getProjectIssues,
  getTeamIssues,
  getWorkspaceWorkItems,
  previewTeamIssueSchedule,
  TeamIssuesApiError,
  updateTeamIssue,
} from '../src/issues/api'
import {
  isCanonicalWorkItem,
  isWorkItemTypeChangePreview,
} from '../src/work-items/api/contractValidation'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-1',
  idempotencyKey: 'idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('canonical Work Item API', () => {
  test('validates canonical causal timestamps at the response boundary', () => {
    const valid = createWorkItem({
      approvalSummary: {
        approvedCount: 0,
        changesRequestedCount: 0,
        overdueCount: 0,
        pendingCount: 1,
        rejectedCount: 0,
        updatedAt: '2026-07-12T03:00:00.000Z',
      },
      dueDate: '2026-07-12',
      dueDateUpdatedAt: '2026-07-12T02:00:00.000Z',
      priorityUpdatedAt: '2026-07-12T01:00:00.000Z',
      schedule: createDefaultTestSchedule('2026-07-12'),
      updatedAt: '2026-07-12T02:00:00.000Z',
    })

    expect(isCanonicalWorkItem(valid)).toBeTrue()

    const invalidCandidates = [
      { ...valid, createdAt: '2026-07-12T00:00:00Z' },
      { ...valid, updatedAt: '2026-07-11T23:59:59.999Z' },
      { ...valid, priorityUpdatedAt: '2026-07-11T23:59:59.999Z' },
      { ...valid, dueDateUpdatedAt: '2026-07-12T02:00:00.001Z' },
      { ...valid, dueDateUpdatedAt: '2026-07-12T02:00:00Z' },
      {
        ...valid,
        approvalSummary: {
          ...valid.approvalSummary,
          updatedAt: '2026-07-12T03:00:00Z',
        },
      },
      {
        ...valid,
        approvalSummary: {
          ...valid.approvalSummary,
          updatedAt: '2026-07-11T23:59:59.999Z',
        },
      },
      { ...valid, workItemTypeId: 42 },
      { ...valid, workItemTypeId: { id: 'bug' } },
    ]
    for (const candidate of invalidCandidates) {
      expect(isCanonicalWorkItem(candidate)).toBeFalse()
    }
  })

  test('requires complete definitions for missing fields in a type-change preview', () => {
    const definition = {
      id: 'risk-level',
      name: 'Risk level',
      required: true,
      sortOrder: 0,
      type: 'select',
      options: [{ id: 'high', name: 'High', sortOrder: 0 }],
    }
    const preview = {
      currentWorkItemTypeId: 'default',
      currentWorkflowStatusId: 'active',
      expectedRevision: 3,
      lostCustomFieldIds: [],
      missingRequiredCustomFieldDefinitions: [definition],
      missingRequiredCustomFieldIds: [definition.id],
      requiresResolution: true,
      targetInitialWorkflowStatusId: 'backlog',
      targetWorkItemTypeId: 'incident',
    }

    expect(isWorkItemTypeChangePreview(preview)).toBeTrue()
    expect(isWorkItemTypeChangePreview({
      ...preview,
      missingRequiredCustomFieldDefinitions: undefined,
    })).toBeFalse()
    expect(isWorkItemTypeChangePreview({
      ...preview,
      missingRequiredCustomFieldDefinitions: [{ ...definition, type: 42 }],
    })).toBeFalse()
  })

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

  test('opts task-view list endpoints into archived Work Items through URL queries', async () => {
    const workItem = createWorkItem({ archivedAt: '2026-08-09T00:00:00.000Z' })

    let requests = installFetchRecorder({ issues: [workItem], teamId: 'core team' })
    await expect(getTeamIssues('core team', 'access-token', true)).resolves.toEqual([workItem])
    expect(requests[0]?.url).toBe('/api/teams/core%20team/issues?includeArchived=true')

    requests = installFetchRecorder({ issues: [workItem], projectId: 'launch / plan' })
    await expect(getProjectIssues('launch / plan', 'access-token', true)).resolves.toEqual([workItem])
    expect(requests[0]?.url).toBe(
      '/api/projects/launch%20%2F%20plan/issues?includeArchived=true',
    )

    requests = installFetchRecorder({ workItems: [workItem] })
    await expect(getWorkspaceWorkItems('access-token', true)).resolves.toEqual([workItem])
    expect(requests[0]?.url).toBe('/api/work-items?includeArchived=true')
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

  test('confirms the original schedule operation with evaluated and graph revisions', async () => {
    const schedule = {
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      dueDate: '2026-08-03',
      mode: 'due-date',
    } satisfies WorkItemSchedule
    const previousSchedule = {
      ...schedule,
      dueDate: '2026-08-02',
    } satisfies WorkItemSchedule
    const impacts = [{
      after: schedule,
      before: previousSchedule,
      dateDeltaDays: 1,
      expectedRevision: 3,
      kind: 'direct',
      teamId: 'core team',
      workItemId: 'issue/1',
    }] satisfies WorkItemScheduleImpact[]
    const compactResponse = {
      workItems: [{
        assignedProjectId: 'refero',
        dueDate: '2026-08-03',
        id: 'issue/1',
        revision: 4,
        schedule,
        teamId: 'core team',
      }],
    }
    const requests = installFetchRecorder(compactResponse)

    await expect(confirmTeamIssueSchedule('core team', 'issue/1', 'access-token', {
      confirmed: true,
      expectedEvaluatedRevisions: [{
        expectedRevision: 3,
        teamId: 'core team',
        workItemId: 'issue/1',
      }],
      expectedImpacts: impacts,
      expectedPlanningRevision: 12,
      expectedRelationGraphRevision: 8,
      expectedRevision: 3,
      operation: { schedule, type: 'replace' },
    }, mutationContext)).resolves.toEqual(compactResponse)

    expect(requests[0]?.url).toBe('/api/teams/core%20team/issues/issue%2F1/schedule/confirm')
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'idempotency-1',
      'X-Correlation-Id': 'correlation-1',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      confirmed: true,
      expectedEvaluatedRevisions: [{
        expectedRevision: 3,
        teamId: 'core team',
        workItemId: 'issue/1',
      }],
      expectedImpacts: impacts,
      expectedPlanningRevision: 12,
      expectedRelationGraphRevision: 8,
      expectedRevision: 3,
      operation: { schedule, type: 'replace' },
    })
    expect(requests).toHaveLength(1)
  })

  test('rejects malformed successful schedule preview and confirmation responses', async () => {
    installFetchRecorder({ expectedRevision: 3, impacts: [], warnings: [] })

    await expect(previewTeamIssueSchedule(
      'core-team',
      'issue-1',
      'access-token',
      { expectedRevision: 3, operation: { targetDate: '2026-08-03', type: 'move' } },
    )).rejects.toMatchObject({ code: 'InvalidWorkItemSchedulePreview', status: 502 })

    installFetchRecorder({
      preview: {},
      workItems: [{
        dueDate: '2026-08-03',
        id: 'issue-1',
        revision: 4,
        schedule: createDefaultTestSchedule('2026-08-03'),
        teamId: 'core-team',
      }],
    })
    await expect(confirmTeamIssueSchedule('core-team', 'issue-1', 'access-token', {
      confirmed: true,
      expectedEvaluatedRevisions: [{
        expectedRevision: 3,
        teamId: 'core-team',
        workItemId: 'issue-1',
      }],
      expectedImpacts: [{
        after: createDefaultTestSchedule('2026-08-03'),
        before: createDefaultTestSchedule('2026-08-02'),
        dateDeltaDays: 1,
        expectedRevision: 3,
        kind: 'direct',
        teamId: 'core-team',
        workItemId: 'issue-1',
      }],
      expectedPlanningRevision: 1,
      expectedRelationGraphRevision: 1,
      expectedRevision: 3,
      operation: { targetDate: '2026-08-03', type: 'move' },
    }, mutationContext)).rejects.toMatchObject({
      code: 'InvalidWorkItemScheduleConfirmationResponse',
      status: 502,
    })
  })

  test('rejects a schedule preview whose direct impact targets another Work Item', async () => {
    const before = createDefaultTestSchedule('2026-08-02')
    const after = createDefaultTestSchedule('2026-08-03')
    installFetchRecorder({
      affectedMilestoneIds: [],
      affectedProjects: [],
      conflicts: [],
      evaluatedRevisions: [{
        expectedRevision: 3,
        teamId: 'other-team',
        workItemId: 'other-issue',
      }],
      expectedRevision: 3,
      impacts: [{
        after,
        before,
        dateDeltaDays: 1,
        expectedRevision: 3,
        kind: 'direct',
        teamId: 'other-team',
        workItemId: 'other-issue',
      }],
      planningRevision: 1,
      relationGraphRevision: 1,
      requiresConfirmation: true,
      warnings: [],
    })

    await expect(previewTeamIssueSchedule(
      'core-team',
      'issue-1',
      'access-token',
      { expectedRevision: 3, operation: { targetDate: '2026-08-03', type: 'move' } },
    )).rejects.toMatchObject({ code: 'InvalidWorkItemSchedulePreview', status: 502 })
  })

  test('rejects a schedule preview with legacy unqualified Project IDs', async () => {
    const before = createDefaultTestSchedule('2026-08-02')
    const after = createDefaultTestSchedule('2026-08-03')
    const legacyPreview = {
      affectedMilestoneIds: ['milestone-beta'],
      affectedProjectIds: ['shared-project'],
      conflicts: [],
      evaluatedRevisions: [{
        expectedRevision: 3,
        teamId: 'core-team',
        workItemId: 'issue-1',
      }],
      expectedRevision: 3,
      impacts: [{
        after,
        before,
        dateDeltaDays: 1,
        expectedRevision: 3,
        kind: 'direct',
        teamId: 'core-team',
        workItemId: 'issue-1',
      }],
      planningRevision: 1,
      relationGraphRevision: 1,
      requiresConfirmation: true,
      warnings: [],
    }
    installFetchRecorder(legacyPreview)

    await expect(previewTeamIssueSchedule(
      'core-team',
      'issue-1',
      'access-token',
      { expectedRevision: 3, operation: { targetDate: '2026-08-03', type: 'move' } },
    )).rejects.toMatchObject({ code: 'InvalidWorkItemSchedulePreview', status: 502 })
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

/** Creates a canonical due-date schedule for API boundary tests. */
function createDefaultTestSchedule(dueDate: string): WorkItemSchedule {
  return {
    calendarPolicy: {
      holidays: [],
      timeZone: 'UTC',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dueDate,
    mode: 'due-date',
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
