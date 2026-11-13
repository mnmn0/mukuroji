import { afterEach, describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type WorkItemSchedule,
  type WorkItemScheduleImpact,
} from '@mukuroji/contracts'
import {
  confirmTeamIssueSchedule,
  previewTeamIssueSchedule,
  TeamIssuesApiError,
  updateTeamIssue,
} from '../src/issues/api'
import { describeScopedWorkItemListError } from '../src/issues/model/workItemListError'
import {
  loadProjectIssues,
  loadTeamIssues,
} from '../src/issues/queries/scopedWorkItemLoader'
import { loadWorkspaceWorkItems } from '../src/issues/queries/workspaceWorkItemLoader'
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

  test('validates acceptance criteria at the response boundary', () => {
    const criterion = { id: 'a'.repeat(32), text: 'Tests pass', satisfied: false }
    const valid = createWorkItem({ dueDate: '2026-07-12', schedule: createDefaultTestSchedule('2026-07-12') })
    expect(isCanonicalWorkItem({ ...valid, acceptanceCriteria: [criterion] })).toBeTrue()
    for (const acceptanceCriteria of [
      [],
      [{ ...criterion, id: 'not-hex' }],
      [{ ...criterion, text: '' }],
      [{ ...criterion, text: 'x'.repeat(1025) }],
      [{ ...criterion, satisfied: 'no' }],
      [criterion, criterion],
      Array.from({ length: 21 }, (_, index) => ({ ...criterion, id: index.toString(16).padStart(32, '0') })),
    ]) {
      expect(isCanonicalWorkItem({ ...valid, acceptanceCriteria })).toBeFalse()
    }
  })

  test('validates contributor assignments at the response boundary', () => {
    const contributor = {
      assignmentId: 'a'.repeat(32),
      memberUserId: 'suzuki@example.com',
      jobRoleId: 'designer',
      plannedEffortMinutes: 90,
      status: 'in-progress',
    }
    const valid = createWorkItem({ dueDate: '2026-07-12', schedule: createDefaultTestSchedule('2026-07-12') })
    expect(isCanonicalWorkItem(valid)).toBeTrue()
    expect(isCanonicalWorkItem({ ...valid, contributorAssignments: [contributor] })).toBeTrue()
    expect(isCanonicalWorkItem({ ...valid, contributorAssignments: [{ assignmentId: 'b'.repeat(32), jobRoleId: 'qa', status: 'planned' }] })).toBeTrue()

    for (const contributorAssignments of [
      {},
      [{ ...contributor, status: 'blocked' }],
      [{ ...contributor, plannedEffortMinutes: 1.5 }],
      [{ assignmentId: 'c'.repeat(32), status: 'planned' }],
      // The canonical contract bounds effort, the list size, and assignment ID uniqueness.
      [{ ...contributor, plannedEffortMinutes: 60_001 }],
      Array.from({ length: 21 }, (_, index) => ({ ...contributor, assignmentId: index.toString(16).padStart(32, '0') })),
      [contributor, contributor],
      // One member cannot hold two assignments, even under distinct assignment IDs.
      [contributor, { ...contributor, assignmentId: 'd'.repeat(32) }],
      // Identifiers must use the grammar the server stores.
      [{ ...contributor, assignmentId: 'not-hex' }],
      [{ ...contributor, memberUserId: '' , jobRoleId: undefined }],
      [{ ...contributor, memberUserId: 'Suzuki@Example.com' }],
      [{ ...contributor, jobRoleId: '-bad-' }],
    ]) {
      expect(isCanonicalWorkItem({ ...valid, contributorAssignments })).toBeFalse()
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
      approvalCompletionTransitionConflict: false,
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

    const result = await loadWorkspaceWorkItems('access-token')

    expect(result).toEqual([workItem])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/work-items?limit=200')
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('follows Workspace Work Item cursors and sends server-side filters', async () => {
    const first = createWorkItem({ id: 'first' })
    const second = createWorkItem({ id: 'second' })
    const responses = [
      { workItems: [first], nextCursor: 'cursor 1' },
      { workItems: [second] },
    ]
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      return new Response(JSON.stringify(responses.shift()), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }) as typeof fetch

    const result = await loadWorkspaceWorkItems('access-token', false, {
      involvement: 'mine',
      teamId: 'core team',
      statusCategories: ['started', 'unstarted'],
      openOnly: true,
    })

    expect(result).toEqual([first, second])
    expect(requests).toEqual([
      '/api/work-items?limit=200&involvement=mine&teamId=core+team&statusCategory=started&statusCategory=unstarted&open=true',
      '/api/work-items?limit=200&involvement=mine&teamId=core+team&statusCategory=started&statusCategory=unstarted&open=true&cursor=cursor+1',
    ])
  })

  test('fails closed when a Workspace Work Item read repeats its cursor', async () => {
    installFetchRecorder({ workItems: [], nextCursor: 'again' })

    await expect(loadWorkspaceWorkItems('access-token')).rejects.toMatchObject({
      status: 503,
      code: 'WorkItemListReadStalled',
    })
  })

  test('keeps following empty filtered pages until the server runs out of rows', async () => {
    const workItem = createWorkItem({ id: 'mine' })
    let page = 0
    installSequentialFetch(() => {
      page += 1
      return page <= 60
        ? { workItems: [], nextCursor: `cursor-${page}` }
        : { workItems: [workItem] }
    })

    await expect(loadWorkspaceWorkItems('access-token', false, { involvement: 'mine' }))
      .resolves.toEqual([workItem])
    expect(page).toBe(61)
  })

  test('fails closed once a Workspace Work Item read passes 10,000 items', async () => {
    const workItems = Array.from({ length: 200 }, () => createWorkItem())
    let page = 0
    installSequentialFetch(() => {
      page += 1
      return { workItems, nextCursor: `cursor-${page}` }
    })

    await expect(loadWorkspaceWorkItems('access-token')).rejects.toMatchObject({
      status: 413,
      code: 'WorkItemListLimitExceeded',
    })
    expect(page).toBe(51)
  })

  test('opts task-view list endpoints into archived Work Items through URL queries', async () => {
    const workItem = createWorkItem({ archivedAt: '2026-08-09T00:00:00.000Z' })

    let requests = installFetchRecorder({ issues: [workItem], teamId: 'core team' })
    await expect(loadTeamIssues('core team', 'access-token', true)).resolves.toEqual([workItem])
    expect(requests[0]?.url).toBe('/api/teams/core%20team/issues?limit=200&includeArchived=true')

    requests = installFetchRecorder({ issues: [workItem], projectId: 'launch / plan' })
    await expect(loadProjectIssues('launch / plan', 'access-token', true)).resolves.toEqual({
      projectId: 'launch / plan',
      issues: [workItem],
    })
    expect(requests[0]?.url).toBe(
      '/api/projects/launch%20%2F%20plan/issues?limit=200&includeArchived=true',
    )

    requests = installFetchRecorder({ workItems: [workItem] })
    await expect(loadWorkspaceWorkItems('access-token', true)).resolves.toEqual([workItem])
    expect(requests[0]?.url).toBe('/api/work-items?limit=200&includeArchived=true')
  })

  test('follows Team and Project page cursors and keeps the Project capability', async () => {
    const pages = [
      { teamId: 'core-team', issues: [createWorkItem({ id: 'item-a' })], nextCursor: 'cursor-1' },
      { teamId: 'core-team', issues: [], nextCursor: 'cursor-2' },
      // A reorder between page reads can return a Work Item again; the later copy wins.
      {
        teamId: 'core-team',
        issues: [createWorkItem({ id: 'item-b' }), createWorkItem({ id: 'item-a', revision: 4 })],
      },
    ]
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      return new Response(JSON.stringify(pages.shift()), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }) as typeof fetch

    const issues = await loadTeamIssues('core-team', 'access-token')
    expect(issues.map((issue) => [issue.id, issue.revision])).toEqual([['item-a', 4], ['item-b', 3]])
    expect(requests).toEqual([
      '/api/teams/core-team/issues?limit=200',
      '/api/teams/core-team/issues?limit=200&cursor=cursor-1',
      '/api/teams/core-team/issues?limit=200&cursor=cursor-2',
    ])

    let projectPage = 0
    installSequentialFetch(() => {
      projectPage += 1
      return projectPage === 1
        ? {
            projectId: 'launch',
            issues: [createWorkItem({ id: 'item-a' })],
            canReadCustomerImpact: true,
            nextCursor: 'cursor-1',
          }
        : { projectId: 'launch', issues: [createWorkItem({ id: 'item-b' })], canReadCustomerImpact: true }
    })
    const project = await loadProjectIssues('launch', 'access-token')
    expect(project.issues.map((issue) => issue.id)).toEqual(['item-a', 'item-b'])
    expect(project.canReadCustomerImpact).toBeTrue()
  })

  test('fails a Team list read that repeats its cursor instead of showing a partial list', async () => {
    installSequentialFetch(() => ({ teamId: 'core-team', issues: [], nextCursor: 'same' }))

    await expect(loadTeamIssues('core-team', 'access-token')).rejects.toMatchObject({
      status: 503,
      code: 'WorkItemListReadStalled',
    })
  })

  test('describes list limit and stalled reads with their cause', () => {
    const t = (key: string) => key === 'tasks.error.reason' ? 'Cause: {reason}' : key

    expect(describeScopedWorkItemListError(
      new TeamIssuesApiError(413, 'More than 10000 Work Items match this view.', 'WorkItemListLimitExceeded'),
      t,
    )).toBe('tasks.error.scopeLimitExceeded Cause: More than 10000 Work Items match this view.')
    expect(describeScopedWorkItemListError(
      new TeamIssuesApiError(503, '', 'WorkItemListReadStalled'),
      t,
    )).toBe('tasks.error.readStalled')
    expect(describeScopedWorkItemListError(new TeamIssuesApiError(500, 'boom'), t)).toBeUndefined()
    expect(describeScopedWorkItemListError(new Error('boom'), t)).toBeUndefined()
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

    const error = await loadWorkspaceWorkItems('access-token').catch((reason: unknown) => reason)

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

    const error = await loadWorkspaceWorkItems('access-token').catch((reason: unknown) => reason)

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

function installSequentialFetch(nextResponseBody: () => unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(nextResponseBody()), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })) as typeof fetch
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
