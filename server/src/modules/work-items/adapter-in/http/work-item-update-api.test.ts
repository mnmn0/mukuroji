import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DynamoDbTeamIssuesClient,
} from '../../adapter-out/dynamodb/work-item-client'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Creates one strict persisted date-range Work Item for preview adapter tests. */
function createDateRangeWorkItem(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: 'Scheduled Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-22',
    schedule: {
      mode: 'date-range',
      startDate: '2026-06-18',
      endDate: '2026-06-22',
      durationDays: 3,
      calendarPolicy: {
        timeZone: 'Asia/Tokyo',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        holidays: [],
      },
    },
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
}

test('updates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '更新済み Issue',
      assignedProjectId: null,
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-22'),
      priority: 'low',
      workflowStatusId: 'done',
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      teamId: 'core-team',
      title: '更新済み Issue',
      assigneeEmail: 'sato@example.com',
      workflowStatusId: 'done',
      statusCategory: 'completed',
      dueDate: '2026-06-22',
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-22',
      },
      priority: 'low',
    },
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  })
  expect(calls.issueUpdates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: null,
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    },
  ])
})

test('updates and returns an explicit canonical Work Item schedule', async () => {
  configureFakeProjectClients(true)
  const schedule = {
    mode: 'date-range',
    startDate: '2026-06-22',
    endDate: '2026-06-26',
    durationDays: 5,
    plannedEffortMinutes: 900,
    calendarPolicy: {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
    },
  }

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schedule,
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      revision: 2,
      dueDate: '2026-06-26',
      schedule,
    },
  })
})

test('rejects a direct dueDate field even when update also includes a schedule', async () => {
  const calls = configureFakeProjectClients(true)
  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dueDate: '2026-06-24',
      expectedRevision: 1,
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemSchedule',
    message: 'dueDate is derived from schedule and cannot be written directly.',
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects non-object Work Item update bodies before reading schedule fields', async () => {
  const calls = configureFakeProjectClients(true)

  for (const body of [JSON.stringify('not-an-object'), JSON.stringify([])]) {
    const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
      method: 'PATCH',
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

  expect(calls.issueDetails).toEqual([])
  expect(calls.issueUpdates).toEqual([])
})

test('previews moving a due-date Work Item without mutating it', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    expectedRevision: 1,
    impacts: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      kind: 'direct',
      expectedRevision: 1,
      before: {
        mode: 'due-date',
        dueDate: '2026-06-18',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
      after: {
        mode: 'due-date',
        dueDate: '2026-06-24',
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
    }],
    relationGraphRevision: 0,
    warnings: [],
  })
  expect(calls.issueDetails).toEqual([{
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  }])
})

test('previews visible blocked Work Items as revision-bound dependency ripple candidates', async () => {
  const calls = configureFakeProjectClients(true, {
    workItemRelationGraphRevision: 12,
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'release-follow-up',
      type: 'blocks',
    }],
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    expectedRevision: 1,
    impacts: [
      {
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        kind: 'direct',
        expectedRevision: 1,
        before: { mode: 'due-date', dueDate: '2026-06-18' },
        after: { mode: 'due-date', dueDate: '2026-06-24' },
      },
      {
        teamId: 'core-team',
        workItemId: 'release-follow-up',
        kind: 'dependency',
        expectedRevision: 1,
        before: { mode: 'due-date', dueDate: '2026-06-18' },
        after: { mode: 'due-date', dueDate: '2026-06-18' },
      },
    ],
    relationGraphRevision: 12,
    warnings: ['DependencyRippleRequiresReview'],
  })
  expect(calls.issueDetails.filter(({ issueId }) => issueId === 'release-follow-up'))
    .toHaveLength(1)
})

test('previews resizing a date-range Work Item with calendar-aware duration', async () => {
  configureFakeProjectClients(true)
  const currentIssue = createDateRangeWorkItem()
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  setTestAppDependencies({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'resize', endDate: '2026-06-24' },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    expectedRevision: 1,
    impacts: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      kind: 'direct',
      expectedRevision: 1,
      before: {
        mode: 'date-range',
        startDate: '2026-06-18',
        endDate: '2026-06-22',
        durationDays: 3,
      },
      after: {
        mode: 'date-range',
        startDate: '2026-06-18',
        endDate: '2026-06-24',
        durationDays: 5,
      },
    }],
    warnings: [],
  })
})

test('rejects stale, invalid, and unauthorized schedule previews', async () => {
  let calls = configureFakeProjectClients(true)
  const staleResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 2,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )
  expect(staleResponse.status).toBe(409)
  expect(await staleResponse.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })

  const invalidResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'resize', endDate: '2026-06-24' },
      }),
    },
  )
  expect(invalidResponse.status).toBe(400)
  expect(await invalidResponse.json()).toMatchObject({
    code: 'InvalidWorkItemScheduleOperation',
  })

  resetTestApp()
  calls = configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const forbiddenResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/schedule/preview',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operation: { type: 'move', targetDate: '2026-06-24' },
      }),
    },
  )
  expect(forbiddenResponse.status).toBe(403)
  expect(calls.issueDetails).toEqual([])
})

test('rejects internal archive fields on the public Work Item update endpoint', async () => {
  const calls = configureFakeProjectClients(true)
  const archiveFields = [
    { archivedAt: '2026-07-17T00:00:00.000Z' },
    { archivedBy: 'attacker@example.com' },
  ]

  for (const archiveField of archiveFields) {
    const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...archiveField,
        expectedRevision: 1,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'InvalidWorkItemArchiveUpdate',
      message: 'Work Item archive fields cannot be updated through this endpoint.',
    })
  }

  expect(calls.issueUpdates).toEqual([])
})

test('returns a stable conflict code when a Work Item revision is stale', async () => {
  configureFakeProjectClients(true)
  const currentIssue = {
    schemaVersion: 2,
    revision: 2,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-18',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  setTestAppDependencies({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })
})

test('requires a positive expected revision for Work Item updates', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done' }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemRevision',
    message: 'Work Item expected revision is required.',
  })
})

test('loads only canonical project execution Work Items', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/projects/refero/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([
    'onboarding-friction',
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([])
})
