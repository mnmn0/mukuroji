import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createCollaborationStub,
  createDocumentFake,
  createFakeWorkItemConfigurationClient,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createCanonicalPublicWorkItemService,
} from '../../../../api/api-router'
import type {
  CollaborationClient,
} from '../../../collaboration/collaboration'
import {
  CollaborationError,
} from '../../../collaboration/collaboration'
import {
  type CanonicalWorkItem,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../../planning/planning'
import { createWorkItemAuthorizationChangedError } from '../../adapter-out/dynamodb/work-item-client'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { AuthenticatedDeveloperCredential } from '../../../developer-platform/application/ports'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Adds every current server-only Work Item field to an API test fixture.
 *
 * @param workItem - Canonical fixture returned by the fake persistence port.
 * @returns Fixture carrying causal, intake, archive, and approval internals.
 */
function addInternalWorkItemFields(workItem: CanonicalWorkItem): CanonicalWorkItem {
  return {
    ...workItem,
    priorityUpdatedAt: '2026-06-08T01:00:00.000Z',
    dueDateUpdatedAt: '2026-06-08T01:00:00.000Z',
    sourceRequestId: 'request-internal-1',
    archivedAt: '2026-06-08T02:00:00.000Z',
    archivedBy: 'internal-operator@example.com',
    approvalSummary: {
      pendingCount: 1,
      overdueCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      changesRequestedCount: 0,
      updatedAt: '2026-06-08T02:00:00.000Z',
    },
  }
}

/** Current internal Work Item fields excluded by the closed public schema. */
const internalWorkItemFields = [
  'priorityUpdatedAt',
  'dueDateUpdatedAt',
  'sourceRequestId',
  'archivedAt',
  'archivedBy',
  'approvalSummary',
]

test('loads only canonical team-owned Work Items after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.teamId).toBe('core-team')
  expect(body.issues).toEqual([
    expect.objectContaining({
      id: 'onboarding-friction',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '初回オンボーディングの離脱要因を減らす',
      assigneeEmail: 'sato@example.com',
    }),
  ])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
})

test('loads all accessible canonical Work Items including unassigned items', async () => {
  const calls = configureFakeProjectClients(true, {
    taskAssigneeUserId: 'sato@example.com',
    unassignedIssue: true,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'onboarding-friction',
  ])
  expect(body.workItems[0]).toMatchObject({
    schemaVersion: 2,
    revision: 1,
    teamId: 'core-team',
    source: 'dynamodb',
    dueDate: '2026-06-18',
    schedule: {
      mode: 'due-date',
      dueDate: '2026-06-18',
    },
  })
  expect(body.workItems[0].assignedProjectId).toBeUndefined()
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.projectIssueReads).toEqual([])
})

test('rejects an oversized Work Item aggregate instead of returning a silent partial response', async () => {
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    code: 'WorkItemListLimitExceeded',
    message:
      'Workspace has more than 200 accessible Work Items. ' +
      'Refine the Workspace before loading the aggregate Work Item list.',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects Work Item aggregate Team fan-out beyond the hard cap before item reads', async () => {
  const additionalTeams = Array.from({ length: 24 }, (_, teamIndex) => ({
    id: `team-${teamIndex}`,
    name: `Team ${teamIndex}`,
    projects: Array.from({ length: 6 }, (_, projectIndex) => ({
      id: `project-${teamIndex}-${projectIndex}`,
      name: `Project ${teamIndex}-${projectIndex}`,
      tone: 'blue' as const,
    })),
  }))
  const calls = configureFakeProjectClients(true, {
    additionalTeams,
    directoryId: 'workspace-export',
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      ...additionalTeams.flatMap((team) =>
        team.projects.map((project) => ({ projectId: project.id, role: 'manager' as const }))
      ),
    ],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('allows current system administrators to select an active Webhook Team', async () => {
  const calls = configureFakeProjectClients(false, {
    systemAdminMemberKeys: ['demo@example.com'],
    workspaceRole: 'owner',
  })
  const service = createCanonicalPublicWorkItemService()

  await expect(runWithTestAppDependencies(() =>
    service.authorizeWebhookTeams({
      workspaceId: 'user#demo@example.com',
      userId: 'demo@example.com',
      capabilities: {
        canManageCredentials: true,
        canManageWebhooks: true,
        canManageIntegrations: true,
        canImport: true,
        canExport: true,
      },
    }, ['core-team'])
  )).resolves.toBeUndefined()
  expect(calls.accessChecks).toContainEqual({
    directoryId: 'user#demo@example.com',
    projectId: '*',
  })
  expect(calls.directoryReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    locale: 'ja',
    consistentRead: true,
  })
})

test('projects every Public Work Item service result onto the closed response schema', async () => {
  configureFakeProjectClients(true, {
    directoryId: 'workspace-1',
    workspaceRole: 'owner',
  })
  const baseTeamIssues = getTestAppDependencies().workItems.teamIssues
  let preparedUpdateReceipt: unknown
  const platform = createInMemoryDeveloperPlatformAdapters()
  setTestAppDependencies({
    ...platform,
    documents: createDocumentFake({
      async prepareWorkItemDeletionFenceTransactWrite() {
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DocumentsTable',
              Item: { activeBacklinkCount: 0 },
            },
          },
        }
      },
    }),
    transactions: {
      async prepareIdempotencyCompletionTransactWrite(request) {
        preparedUpdateReceipt = structuredClone(request.response)
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency-completion' },
            },
          },
        }
      },
    },
    teamIssues: createTeamIssuesFake({
      ...baseTeamIssues,
      async getPublicWorkItemPage(directoryId, teamId, options) {
        const page = await baseTeamIssues.getPublicWorkItemPage(directoryId, teamId, options)
        return { ...page, issues: page.issues.map(addInternalWorkItemFields) }
      },
      async getTeamIssueDetail(directoryId, teamId, issueId, options) {
        const detail = await baseTeamIssues.getTeamIssueDetail(
          directoryId,
          teamId,
          issueId,
          options,
        )
        return { ...detail, issue: addInternalWorkItemFields(detail.issue) }
      },
      async createTeamIssue(directoryId, teamId, input, actorUserId, auditContext) {
        const response = await baseTeamIssues.createTeamIssue(
          directoryId,
          teamId,
          input,
          actorUserId,
          auditContext,
        )
        return { issue: addInternalWorkItemFields(response.issue) }
      },
      async updateTeamIssue(
        directoryId,
        teamId,
        issueId,
        input,
        actorUserId,
        auditContext,
        idempotency,
      ) {
        const response = await baseTeamIssues.updateTeamIssue(
          directoryId,
          teamId,
          issueId,
          input,
          actorUserId,
          auditContext,
        )
        const issue = addInternalWorkItemFields(response.issue)
        await idempotency?.prepare({ status: 200, body: issue })
        return { issue }
      },
      async deleteTeamIssue(
        directoryId,
        teamId,
        issueId,
        expectedRevision,
        actorUserId,
        auditContext,
        idempotency,
        deletionFences,
        authorizationConditionChecks,
        authorizationSnapshot,
      ) {
        if (baseTeamIssues.deleteTeamIssue === undefined) {
          throw new Error('Expected the Public Work Item delete fake to be configured.')
        }
        const response = await baseTeamIssues.deleteTeamIssue(
          directoryId,
          teamId,
          issueId,
          expectedRevision,
          actorUserId,
          auditContext,
          idempotency,
          deletionFences,
          authorizationConditionChecks,
          authorizationSnapshot,
        )
        return { issue: addInternalWorkItemFields(response.issue) }
      },
    }),
  })
  const service = createCanonicalPublicWorkItemService()
  const credential = {
    kind: 'api-key',
    workspaceId: 'workspace-1',
    credentialId: 'closed-public-work-item-key',
    subjectUserId: 'demo@example.com',
    scopes: ['work-items:read', 'work-items:write', 'work-items:delete'],
  } satisfies AuthenticatedDeveloperCredential
  const mutationContext = {
    requestId: 'closed-public-work-item-request',
    idempotencyKey: 'closed-public-work-item-request',
  }
  const results = await runWithTestAppDependencies(async () => {
    const page = await service.list(credential, { teamId: 'core-team' }, undefined, 10)
    const item = await service.get(credential, 'core-team', 'onboarding-friction')
    const created = await service.create(credential, {
      teamId: 'core-team',
      title: 'Public create projection',
      assigneeUserId: 'sato@example.com',
      assignedProjectId: 'refero',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
      priority: 'medium',
    }, mutationContext)
    const updated = await service.update(
      credential,
      'core-team',
      'onboarding-friction',
      { expectedRevision: 1, title: 'Public update projection' },
      mutationContext,
      {
        credentialId: credential.credentialId,
        idempotencyKey: mutationContext.idempotencyKey,
        requestFingerprint: 'public-update-fingerprint',
        reservationId: 'public-update-reservation',
      },
    )
    const deleted = await service.delete(
      credential,
      'core-team',
      'onboarding-friction',
      1,
      mutationContext,
    )
    return { page, item, created, updated, deleted }
  })

  const projectedItems = [
    results.page.items[0],
    results.item,
    results.created,
    results.updated,
    results.deleted,
  ]
  for (const item of projectedItems) {
    expect(item).toBeDefined()
    expect(item).toMatchObject({
      dueDate: '2026-06-18',
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-18',
      },
    })
    for (const field of internalWorkItemFields) {
      expect(item).not.toHaveProperty(field)
    }
  }
  expect(preparedUpdateReceipt).toBeDefined()
  if (
    typeof preparedUpdateReceipt !== 'object' ||
    preparedUpdateReceipt === null ||
    !('body' in preparedUpdateReceipt)
  ) {
    throw new Error('Expected a prepared Public Work Item replay receipt.')
  }
  for (const field of internalWorkItemFields) {
    expect(preparedUpdateReceipt.body).not.toHaveProperty(field)
  }
  expect(preparedUpdateReceipt.body).toHaveProperty('schedule', expect.objectContaining({
    mode: 'due-date',
    dueDate: '2026-06-18',
  }))
})

test('rejects Public Work Item deletion while an incident schedule dependency exists', async () => {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 2 })
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Delete target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'delete-dependency',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  setTestAppDependencies({ planning })
  const service = createCanonicalPublicWorkItemService()

  await expect(runWithTestAppDependencies(() => service.delete(
    {
      kind: 'api-key',
      workspaceId: 'user#demo@example.com',
      credentialId: 'delete-key',
      subjectUserId: 'demo@example.com',
      scopes: ['work-items:delete'],
    },
    'core-team',
    'onboarding-friction',
    1,
    { requestId: 'delete-dependent', idempotencyKey: 'delete-dependent' },
  ))).rejects.toMatchObject({
    code: 'PlanningWorkItemDependencyInUse',
    status: 409,
  })
  expect(calls.issueDeletes).toEqual([])
})

test('rejects Public Work Item deletion when a dependency is created after its precheck', async () => {
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Delete target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  const calls = configureFakeProjectClients(true, {
    directoryId: 'workspace-1',
    teamIssueCount: 2,
    async issueDeleteHook({ authorizationSnapshot }) {
      expect(authorizationSnapshot?.planningRevision).toBe(0)
      await planning.createWorkItemDependency('workspace-1', {
        id: 'delete-race-dependency',
        predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
        successor: { teamId: 'core-team', workItemId: 'work-item-1' },
        type: 'finish-to-finish',
        lagDays: 0,
        expectedRevision: 0,
      }, workItemState)
      throw createWorkItemAuthorizationChangedError()
    },
  })
  const platform = createInMemoryDeveloperPlatformAdapters()
  setTestAppDependencies({
    ...platform,
    documents: createDocumentFake({
      async prepareWorkItemDeletionFenceTransactWrite() {
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DocumentsTable',
              Item: { activeBacklinkCount: 0 },
            },
          },
        }
      },
    }),
    planning,
  })
  const service = createCanonicalPublicWorkItemService()

  await expect(runWithTestAppDependencies(() => service.delete(
    {
      kind: 'api-key',
      workspaceId: 'workspace-1',
      credentialId: 'delete-race-key',
      subjectUserId: 'demo@example.com',
      scopes: ['work-items:delete'],
    },
    'core-team',
    'onboarding-friction',
    1,
    { requestId: 'delete-race', idempotencyKey: 'delete-race' },
  ))).rejects.toMatchObject({
    code: 'WorkItemAuthorizationChanged',
    status: 409,
  })
  expect(calls.issueDeletes).toEqual([])
})

test('pages all accessible Work Items beyond aggregate Team and item hard caps', async () => {
  const additionalTeams = Array.from({ length: 20 }, (_, teamIndex) => ({
    id: `export-team-${teamIndex}`,
    name: `Export Team ${teamIndex}`,
    projects: [{
      id: `export-project-${teamIndex}`,
      name: `Export Project ${teamIndex}`,
      tone: 'blue' as const,
    }],
  }))
  const calls = configureFakeProjectClients(true, {
    additionalTeams,
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      ...additionalTeams.flatMap((team) =>
        team.projects.map((project) => ({
          projectId: project.id,
          role: 'manager' as const,
        }))
      ),
    ],
    teamIssueCount: 11,
    unassignedIssue: true,
  })
  setTestAppDependencies({
    rateLimits: {
      async consumeRateLimit() {
        return {
          allowed: true,
          limit: 120,
          remaining: 119,
          resetAt: '2026-07-18T00:01:00.000Z',
        }
      },
    },
  })

  const workItems: Array<{ id: string; teamId: string }> = []
  let cursor: string | undefined
  let pageCount = 0
  do {
    const query = new URLSearchParams({ format: 'json', limit: '50' })
    if (cursor) query.set('cursor', cursor)
    const response = await app.request(`/api/developer/exports?${query}`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      items: Array<{ id: string; teamId: string }>
      hasMore: boolean
      nextCursor?: string
    }
    workItems.push(...body.items)
    cursor = body.nextCursor
    expect(body.hasMore).toBe(cursor !== undefined)
    pageCount += 1
  } while (cursor)

  expect(workItems).toHaveLength(231)
  expect(new Set(workItems.map((workItem) => workItem.teamId))).toHaveLength(21)
  expect(pageCount).toBe(21)
  expect(calls.publicIssuePageReads).toHaveLength(21)
  expect(calls.publicIssuePageReads.every((read) => read.limit === 50)).toBe(true)
  expect(calls.issueReads).toEqual([])
})

test('filters canonical Work Items for authorization before enforcing the response limit', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 200,
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'work-item-200',
  ])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects a canonical partition that exceeds the bounded Work Item scan budget', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 1001,
    teamIssueCount: 1001,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.projectIssueReads).toEqual([])
})

test('creates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規 Issue',
      description: 'Issue の説明',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    issue: {
      schemaVersion: 2,
      revision: 1,
      id: 'new-issue',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '新規 Issue',
      description: 'Issue の説明',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'demo@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026-06-20',
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-20',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
      priority: 'medium',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      source: 'dynamodb',
    },
  })
  expect(calls.issueCreates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: 'refero',
      directoryId: 'user#demo@example.com',
      statusCategory: 'unstarted',
      teamId: 'core-team',
      title: '新規 Issue',
      workflowStatusId: 'todo',
    },
  ])
})

test('rejects a direct dueDate field even when create also includes a schedule', async () => {
  const calls = configureFakeProjectClients(true)
  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assigneeUserId: 'sato@example.com',
      dueDate: '2026-06-20',
      priority: 'medium',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      title: 'Invalid direct deadline',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemSchedule',
    message: 'dueDate is derived from schedule and cannot be written directly.',
  })
  expect(calls.issueCreates).toEqual([])
})

test('rejects internal adapter fields at the Work Item create boundary', async () => {
  const calls = configureFakeProjectClients(true)
  const internalFields: ReadonlyArray<readonly [string, unknown]> = [
    ['authorizationConditionChecks', []],
    ['authorizationSnapshot', { planningRevision: 0 }],
    ['configurationConditionChecks', []],
    ['idempotencyResourceId', 'caller-selected-id'],
    ['idempotentIssueId', `api-${'a'.repeat(48)}`],
    ['idempotentRequestDigest', 'b'.repeat(64)],
    ['statusCategory', 'completed'],
    ['workflowSchemaVersion', 99],
  ]

  for (const [field, value] of internalFields) {
    const response = await app.request('/api/teams/core-team/issues', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assigneeUserId: 'sato@example.com',
        priority: 'medium',
        schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
        title: 'Internal field injection',
        workflowStatusId: 'todo',
        [field]: value,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('internal fields'),
    })
  }
  expect(calls.issueCreates).toEqual([])
})

test('rejects non-object Work Item create bodies before reading schedule fields', async () => {
  const calls = configureFakeProjectClients(true)

  for (const body of [JSON.stringify('not-an-object'), JSON.stringify([])]) {
    const response = await app.request('/api/teams/core-team/issues', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body,
    })

    expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        message: 'Work Item body must be an object.',
      })
  }

  expect(calls.issueCreates).toEqual([])
})

test('rejects a team issue assignment to a project outside the owning team', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '不正な割り当て',
      assignedProjectId: 'unknown-project',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(400)
  expect(calls.issueCreates).toEqual([])
})

test('rejects a team issue assignment when the user lacks target project member role', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      {
        projectId: 'refero',
        role: 'member',
      },
    ],
    teamProjects: [
      {
        id: 'refero',
        name: 'Refero',
        tone: 'blue',
      },
      {
        id: 'product-roadmap',
        name: 'プロダクトロードマップ',
        tone: 'yellow',
      },
    ],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '権限外プロジェクトへの割り当て',
      assignedProjectId: 'product-roadmap',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('loads team issue detail and creates comments after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)
  const collaborationCreates: Parameters<CollaborationClient['createComment']>[0][] = []
  const collaborationComments: Awaited<ReturnType<CollaborationClient['createComment']>>[] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getThread() {
        return {
          comments: collaborationComments,
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async createComment(input) {
        collaborationCreates.push(input)
        const comment = {
          id: 'comment-2',
          rootCommentId: 'comment-2',
          authorMemberKey: input.actorMemberKey,
          bodyMarkdown: input.bodyMarkdown,
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T02:00:00.000Z',
          updatedAt: '2026-06-08T02:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
        collaborationComments.push(comment)
        return comment
      },
    }),
  })

  const detailResponse = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      assigneeEmail: 'sato@example.com',
    },
    comments: [
      {
        id: 'comment-1',
        body: '背景を確認します。',
      },
    ],
    activity: [
      {
        id: 'activity-1',
        type: 'created',
      },
    ],
  })

  const commentResponse = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: '追加コメント',
    }),
  })

  expect(commentResponse.status).toBe(201)
  expect(await commentResponse.json()).toEqual({
    comment: {
      id: 'comment-2',
      actorUserId: 'demo@example.com',
      body: '追加コメント',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
    activity: {
      id: 'comment-2',
      type: 'commented',
      actorUserId: 'demo@example.com',
      summary: 'Comment was added.',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true },
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
  expect(calls.issueComments).toEqual([])
  expect(collaborationCreates).toHaveLength(1)
  expect(collaborationCreates[0]).toMatchObject({
    actorMemberKey: 'demo@example.com',
    bodyMarkdown: '追加コメント',
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
  })

  const refreshedDetailResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(refreshedDetailResponse.status).toBe(200)
  expect(await refreshedDetailResponse.json()).toMatchObject({
    comments: [
      { id: 'comment-1', body: '背景を確認します。' },
      { id: 'comment-2', body: '追加コメント' },
    ],
  })
})

test('omits relations whose target Project is outside the viewer access scope', async () => {
  const calls = configureFakeProjectClients(true, {
    detailAssignedProjectIds: { 'onboarding-friction': 'private-project' },
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return {
          graphRevision: 2,
          relations: [{
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'onboarding-friction',
            type: 'related',
            createdAt: '2026-07-14T00:00:00.000Z',
          }, {
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'onboarding-friction',
            type: 'blocks',
            createdAt: '2026-07-14T00:01:00.000Z',
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/work-item-1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    relations: [],
    relationGraphRevision: 2,
  })
  expect(calls.issueReads).toEqual([])
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'work-item-1',
      readOptions: { consistentIssueRead: true },
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
})

test('loads deduplicated relation targets with bounded concurrency and preserves relation order', async () => {
  const targetWorkItemIds = Array.from({ length: 12 }, (_, index) => `target-${index}`)
  const relations = [
    ...targetWorkItemIds.map((targetWorkItemId, index) => ({
      sourceWorkItemId: 'source-work-item',
      targetWorkItemId,
      type: 'related' as const,
      createdAt: `2026-07-14T00:${String(index).padStart(2, '0')}:00.000Z`,
    })),
    {
      sourceWorkItemId: 'source-work-item',
      targetWorkItemId: targetWorkItemIds[0] as string,
      type: 'blocks' as const,
      createdAt: '2026-07-14T01:00:00.000Z',
    },
  ]
  let activeTargetReads = 0
  let maximumActiveTargetReads = 0
  const calls = configureFakeProjectClients(true, {
    async detailReadHook(issueId) {
      if (!issueId.startsWith('target-')) return
      activeTargetReads += 1
      maximumActiveTargetReads = Math.max(maximumActiveTargetReads, activeTargetReads)
      await Promise.resolve()
      activeTargetReads -= 1
    },
  })
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return { graphRevision: 4, relations }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/source-work-item', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const body = await response.json() as { relations: Array<{ targetWorkItemId: string }> }

  expect(response.status).toBe(200)
  expect(maximumActiveTargetReads).toBe(8)
  expect(calls.issueReads).toEqual([])
  expect(
    calls.issueDetails
      .filter(({ issueId }) => issueId.startsWith('target-'))
      .map(({ issueId }) => issueId),
  ).toEqual(targetWorkItemIds)
  expect(body.relations.map(({ targetWorkItemId }) => targetWorkItemId)).toEqual(
    relations.map(({ targetWorkItemId }) => targetWorkItemId),
  )
})

test('fails closed when a persisted relation target Work Item is missing', async () => {
  const calls = configureFakeProjectClients(true, {
    detailMissingIssueIds: ['missing-target'],
  })
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return {
          graphRevision: 3,
          relations: [{
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'missing-target',
            type: 'related',
            createdAt: '2026-07-14T00:00:00.000Z',
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/work-item-1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    code: 'WorkItemRelationInconsistent',
    message: 'A relation target Work Item is missing.',
  })
  expect(calls.issueReads).toEqual([])
  expect(calls.issueDetails.map(({ issueId, readOptions }) => ({ issueId, readOptions }))).toEqual([
    {
      issueId: 'work-item-1',
      readOptions: { consistentIssueRead: true },
    },
    {
      issueId: 'missing-target',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
})

test('returns persisted collaboration comments together with inert legacy comments and reply cursors', async () => {
  const calls = configureFakeProjectClients(true)
  const threadInputs: Parameters<CollaborationClient['getThread']>[0][] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getThread(input) {
        threadInputs.push(input)
        const pageBase = {
          watch: {
            subscribed: true,
            explicit: true,
            automatic: false,
            reasons: ['manual'],
            watcherCount: 2,
          },
          presence: [],
        }
        if (input.rootCommentId) {
          return {
            ...pageBase,
            comments: [{
              id: 'stored-reply',
              rootCommentId: input.rootCommentId,
              parentCommentId: input.rootCommentId,
              authorMemberKey: 'sato@example.com',
              bodyMarkdown: 'Persisted reply',
              version: 1,
              mentionMemberKeys: [],
              createdAt: '2026-07-12T00:01:00.000Z',
              updatedAt: '2026-07-12T00:01:00.000Z',
              acceptedResolutions: [],
              reactions: [],
            }],
            nextCursor: 'older-replies',
          }
        }
        return {
          ...pageBase,
          comments: [{
            id: 'stored-root',
            rootCommentId: 'stored-root',
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: 'Persisted root',
            version: 2,
            mentionMemberKeys: [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:30.000Z',
            editedAt: '2026-07-12T00:00:30.000Z',
            acceptedResolutions: [],
            reactions: [],
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    comments: [
      { id: 'stored-root', source: 'collaboration' },
      { id: 'stored-reply', source: 'collaboration' },
      {
        id: 'comment-1',
        source: 'legacy',
        capabilities: { canReply: false, canReact: false },
      },
    ],
    replyNextCursors: { 'stored-root': 'older-replies' },
  })
  expect(threadInputs).toHaveLength(2)
  expect(threadInputs[0]?.rootCommentId).toBeUndefined()
  expect(threadInputs[0]?.limit).toBe(10)
  expect(threadInputs[1]).toMatchObject({
    rootCommentId: 'stored-root',
    limit: 5,
    includeScopeState: false,
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: {
      consistentIssueRead: true,
      eventLimit: 50,
      newestEventsFirst: true,
      eventType: 'commented',
    },
  })
})

test('keeps a departed author in history while blocking deactivated member mutations', async () => {
  configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['departed@example.com'],
  })
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? []
            : [{
                id: 'departed-comment',
                rootCommentId: 'departed-comment',
                authorMemberKey: 'departed@example.com',
                bodyMarkdown: 'This decision remains in history.',
                version: 1,
                mentionMemberKeys: [],
                createdAt: '2026-07-12T00:00:00.000Z',
                updatedAt: '2026-07-12T00:00:00.000Z',
                acceptedResolutions: [],
                reactions: [],
              }],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const historyResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(historyResponse.status).toBe(200)
  const history = await historyResponse.json() as { comments: unknown[] }
  expect(history.comments).toContainEqual(expect.objectContaining({
    id: 'departed-comment',
    authorMemberKey: 'departed@example.com',
    bodyMarkdown: 'This decision remains in history.',
  }))

  configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })
  let mutationCalls = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async updateComment() {
        mutationCalls += 1
        throw new Error('A deactivated member must not reach the collaboration store.')
      },
    }),
  })
  const mutationResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/departed-comment',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bodyMarkdown: 'Changed', expectedVersion: 1 }),
    },
  )

  expect(mutationResponse.status).toBe(403)
  expect(mutationCalls).toBe(0)
})

test('marks roots and replies in a resolved thread as non-replyable', async () => {
  configureFakeProjectClients(true)
  const root = {
    id: 'resolved-root',
    rootCommentId: 'resolved-root',
    authorMemberKey: 'demo@example.com',
    bodyMarkdown: 'Resolved decision',
    version: 2,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
    resolvedAt: '2026-07-12T00:01:00.000Z',
    acceptedResolutions: [],
    reactions: [],
  }
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? [{
                ...root,
                id: 'resolved-reply',
                parentCommentId: root.id,
                resolvedAt: undefined,
              }]
            : [root],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
          ...(input.rootCommentId ? { threadResolved: true } : {}),
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(response.status).toBe(200)
  const body = await response.json() as {
    comments: Array<{ id: string; capabilities: { canReply: boolean } }>
  }
  expect(body.comments.find((comment) => comment.id === 'resolved-root')?.capabilities.canReply)
    .toBe(false)
  expect(body.comments.find((comment) => comment.id === 'resolved-reply')?.capabilities.canReply)
    .toBe(false)
})

test('denies collaboration reads without Work Item viewer access', async () => {
  configureFakeProjectClients(false)
  let reads = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getThread() {
        reads += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(reads).toBe(0)
})

test('keeps guest members read-only for collaboration mutations', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })
  let writes = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bodyMarkdown: 'Guest comment' }),
  })

  expect(response.status).toBe(403)
  expect(writes).toBe(0)
})

test('returns a client error when a comment mentions an inactive Workspace member', async () => {
  configureFakeProjectClients(true, { inactiveWorkspaceMemberKeys: ['inactive@example.com'] })
  let writes = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bodyMarkdown: 'Please review this, @Inactive.',
      mentionMemberKeys: ['inactive@example.com'],
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    message: 'Mentioned Workspace member "inactive@example.com" is not active.',
  })
  expect(writes).toBe(0)
})

test('allows active system administrators to be mentioned without project membership', async () => {
  for (const unassignedIssue of [false, true]) {
    configureFakeProjectClients(true, {
      mentionAccessDeniedMemberKeys: ['admin@example.com'],
      systemAdminMemberKeys: ['admin@example.com'],
      unassignedIssue,
    })
    const writes: Parameters<CollaborationClient['createComment']>[0][] = []
    setTestAppDependencies({
      collaboration: createCollaborationStub({
        async createComment(input) {
          writes.push(input)
          return {
            id: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            rootCommentId: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            authorMemberKey: input.actorMemberKey,
            bodyMarkdown: input.bodyMarkdown,
            version: 1,
            mentionMemberKeys: input.mentionMemberKeys ?? [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
            acceptedResolutions: [],
            reactions: [],
          }
        },
      }),
    })

    const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bodyMarkdown: 'Please review this, @Admin.',
        mentionMemberKeys: ['admin@example.com'],
      }),
    })

    expect(response.status).toBe(201)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.mentionMemberKeys).toEqual(['admin@example.com'])
  }
})

test('allows a Workspace owner with viewer access to moderate a comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'owner' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes).toHaveLength(1)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('allows an assigned project manager to moderate another member comment', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('denies a project viewer from deleting another member comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  let deletes = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async deleteComment() {
        deletes += 1
        throw new CollaborationError(403, 'CommentDeleteDenied', 'Comment delete permission is required.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(403)
  expect(deletes).toBe(1)
})

test('reads and changes project watcher state through the project scope', async () => {
  configureFakeProjectClients(true)
  const reads: Parameters<CollaborationClient['getWatcherState']>[0][] = []
  const writes: Parameters<CollaborationClient['subscribe']>[0][] = []
  const watch = {
    subscribed: true,
    explicit: true,
    automatic: false,
    reasons: ['manual'],
    watcherCount: 3,
  }
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getWatcherState(input) {
        reads.push(input)
        return watch
      },
      async subscribe(input) {
        writes.push(input)
        return watch
      },
    }),
  })

  const readResponse = await app.request('/api/projects/refero/watch', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/projects/refero/watch', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(readResponse.status).toBe(200)
  expect(writeResponse.status).toBe(200)
  expect(reads).toEqual([{
    entityKey: 'user#demo@example.com#project#refero',
    memberKey: 'demo@example.com',
  }])
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    workspaceId: 'user#demo@example.com',
    entityKey: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    memberKey: 'demo@example.com',
  })
})

test('issues a one-time realtime ticket only after Work Item viewer access is confirmed', async () => {
  configureFakeProjectClients(true)
  const ticketInputs: Array<Record<string, unknown>> = []
  setTestAppDependencies({
    realtimeTickets: {
      async createTicket(input) {
        ticketInputs.push(input)

        return {
          ticket: 'one-time-ticket',
          websocketUrl: 'wss://realtime.example.com/dev',
          expiresAt: '2026-07-12T00:01:00.000Z',
        }
      },
    },
  })

  const response = await app.request('/api/realtime/tickets', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    ticket: 'one-time-ticket',
    websocketUrl: 'wss://realtime.example.com/dev',
    expiresAt: '2026-07-12T00:01:00.000Z',
  })
  expect(ticketInputs).toHaveLength(1)
  expect(ticketInputs[0]).toMatchObject({
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    projectId: 'refero',
    systemAdmin: false,
    canWrite: true,
    scopeKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
    authenticationSessionId: expect.any(String),
    authenticationMethods: [],
    clientIp: 'transport-unavailable',
  })
  expect(ticketInputs[0]?.authenticatedAt).toEqual(expect.any(Number))
  expect(ticketInputs[0]?.tokenExpiresAt).toEqual(expect.any(Number))
})
