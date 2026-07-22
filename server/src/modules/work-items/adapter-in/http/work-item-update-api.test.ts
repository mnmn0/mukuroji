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
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

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
      dueDate: '2026/06/22',
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
      dueDate: '2026/06/22',
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
    schemaVersion: 1,
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
    dueDate: '2026/06/18',
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
