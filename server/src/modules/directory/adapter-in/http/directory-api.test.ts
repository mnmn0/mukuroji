import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createCyclePlanningInput,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DynamoDbProjectDirectoryClient,
} from '../../adapter-out/dynamodb/project-directory-client'
import {
  InMemoryPlanningClient,
} from '../../../planning/planning'
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('denies project tasks when the project is outside the user directory', async () => {
  const calls = configureFakeProjectClients(false)

  const response = await app.request('/api/projects/secret/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'secret' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('loads only legacy project tasks after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['wireframe'])
  expect(body.tasks[0]).toMatchObject({
    source: 'legacy',
    titleKey: 'tasks.item.wireframe',
    status: 'in-progress',
  })
  expect(body.tasks[0]).not.toHaveProperty('workflowStatusId')
  expect(body.tasks[0]).not.toHaveProperty('statusCategory')
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.projectIssueReads).toEqual([])
})

test('lists Cognito users for project member assignment when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUsersNextToken: 'following-page-token',
    role: 'manager',
  })

  const response = await app.request(
    '/api/projects/refero/users?query=sato&limit=1&nextToken=next-page-token',
    {
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    users: [
      {
        id: 'sato@example.com',
        username: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        enabled: true,
        status: 'CONFIRMED',
        workspaceStatus: 'active',
      },
    ],
    nextToken: 'following-page-token',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.userLists).toEqual([{
    directoryId: 'user#demo@example.com',
    limit: 1,
    paginationToken: 'next-page-token',
    query: 'sato',
  }])
  expect(calls.userProfiles).toEqual([])
})

test('continues Cognito pagination until an active Workspace assignment candidate is found', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUserPages: [
      { userIds: ['inactive@example.com'], nextToken: 'active-page' },
      { userIds: ['sato@example.com'], nextToken: 'following-page' },
    ],
    role: 'manager',
  })

  const response = await app.request('/api/projects/refero/users?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    users: [{ id: 'sato@example.com', workspaceStatus: 'active' }],
    nextToken: 'following-page',
  })
  expect(calls.userLists).toEqual([
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: undefined,
      query: undefined,
    },
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: 'active-page',
      query: undefined,
    },
  ])
})

test('keeps project members available when Cognito profile hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
  })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['demo@example.com'])
})

test('keeps project tasks available when Cognito assignee hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
    taskAssigneeUserId: 'sato@example.com',
  })

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['wireframe'])
  expect(body.tasks[0]).toMatchObject({
    id: 'wireframe',
    assigneeUserId: 'sato@example.com',
    source: 'legacy',
  })
  expect(calls.userProfiles).toEqual(['sato@example.com'])
})

test('creates a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規チーム',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    team: {
      id: 'new-team',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(calls.teamCreates).toEqual([
    { directoryId: 'user#demo@example.com', name: '新規チーム' },
  ])
})

test('creates a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
      tone: 'green',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    project: {
      id: 'new-project',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(calls.projectCreates).toEqual([
    {
      creatorUserKey: 'demo@example.com',
      directoryId: 'user#demo@example.com',
      name: '新規プロジェクト',
      teamId: 'core-team',
    },
  ])
})

test('returns conflict when project creation transaction is canceled', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  setTestAppDependencies({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ message: 'The same item already exists.' })
})

test('returns bad gateway when project creation transaction has no cancellation reasons', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  setTestAppDependencies({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'Project data is unavailable.' })
})

test('returns service unavailable when project creation transaction table is missing', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('missing table')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  setTestAppDependencies({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ message: 'Project data is not initialized.' })
})

test('returns not found when project creation transaction loses its active team', async () => {
  configureFakeProjectClients(true)
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
              ...(queryReads >= 2 ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  setTestAppDependencies({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ message: 'Team was not found.' })
})

test('archives a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 0, teamId: 'core-team' },
  ])
})

test('rejects archiving a Team referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-team-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningTeamScopeInUse',
    message:
      'Move or archive active Planning entities and remove Work Item links before archiving this Team.',
  })
  expect(calls.teamArchives).toEqual([])
})

test('denies project-assigned Work Item creation when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-20'),
      priority: 'high',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
  expect(calls.issueCreates).toEqual([])
})

test('denies project member reads when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.memberReads).toEqual([])
})

test('updates a project member role when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, { role: 'manager' })

  const response = await app.request('/api/projects/refero/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      username: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'sato@example.com',
      projectId: 'refero',
      role: 'member',
    },
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('lets a system admin update project members without a project role', async () => {
  const calls = configureFakeProjectClients(false, {
    role: undefined,
    systemAdminMemberKeys: ['demo@example.com'],
  })

  const response = await app.request('/api/projects/refero/members/viewer%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      role: 'viewer',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'viewer@example.com',
      email: 'viewer@example.com',
      username: 'viewer@example.com',
      name: 'Viewer User',
      enabled: true,
      status: 'CONFIRMED',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.roleChecks).toEqual([])
  expect(calls.accessChecks).toEqual([])
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'viewer@example.com',
      projectId: 'refero',
      role: 'viewer',
    },
  ])
  expect(calls.userProfiles).toEqual(['viewer@example.com', 'viewer@example.com'])
})

test('archives a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.projectArchives).toEqual([
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 0,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
})

test('does not block archive for a same-named Project scoped to another Team', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    {
      ...createCyclePlanningInput('cycle-other-team-project', 0),
      teamId: 'other-team',
      projectId: 'refero',
    },
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(calls.projectArchives).toEqual([
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 1,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 1, teamId: 'core-team' },
  ])
})

test('rejects archiving a Project referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-project-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'PlanningProjectScopeInUse',
    message:
      'Move or archive active Planning entities and remove Work Item links before archiving this Project.',
  })
  expect(calls.projectArchives).toEqual([])
})

test('rejects archiving scopes referenced only by a stored Planning Work Item link', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workItemState = {
    workItems: [{
      id: 'linked-work-item',
      revision: 1,
      teamId: 'core-team',
      title: 'Linked Work Item',
      projectId: 'refero',
      statusCategory: 'completed' as const,
      dueDate: '2026-08-31',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    }],
  }
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-link-scope', 0),
    workItemState,
  )
  await planningClient.putWorkItemLink('user#demo@example.com', {
    teamId: 'core-team',
    workItemId: 'linked-work-item',
    projectId: 'refero',
    cycleId: 'cycle-link-scope',
    goalIds: [],
    expectedRevision: 1,
  }, workItemState)
  await planningClient.archive(
    'user#demo@example.com',
    'cycle-link-scope',
    { expectedRevision: 2 },
    workItemState,
  )
  const calls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: planningClient })

  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(teamResponse.status).toBe(409)
  expect(projectResponse.status).toBe(409)
  expect(calls.teamArchives).toEqual([])
  expect(calls.projectArchives).toEqual([])
})
