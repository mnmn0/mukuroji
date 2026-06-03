import { afterEach, expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  app,
  configureApiClientsForTest,
  DynamoDbDashboardSummaryClient,
  DynamoDbProjectDirectoryClient,
  DynamoDbProjectTasksClient,
  resetApiClientsForTest,
} from './index'

afterEach(() => {
  resetApiClientsForTest()
})

test('loads project directory from the authenticated user scoped partition', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/projects?locale=en', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(calls.directoryReads).toEqual([{ directoryId: 'user#demo@example.com', locale: 'en' }])
})

test('loads dashboard summary from the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/dashboard/summary', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projects: 1,
    tasks: 1,
    blocked: 0,
    updatedAt: '2026-06-03T00:00:00.000Z',
    source: 'dynamodb',
  })
  expect(calls.summaryReads).toEqual(['user#demo@example.com'])
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

test('loads project tasks after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
    ],
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('creates a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
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
    { directoryId: 'user#demo@example.com', teamId: 'core-team', name: '新規プロジェクト' },
  ])
})

test('DynamoDB directory client creates duplicate named teams with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#新規チーム',
              entryType: 'team',
              teamId: '新規チーム',
              teamSortOrder: 10,
              nameJa: '新規チーム',
              nameEn: 'New Team',
              expanded: true,
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.createTeam('user#demo@example.com', { name: '新規チーム' })).resolves.toEqual({
    team: {
      id: '新規チーム-2',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '新規チーム-2',
      teamSortOrder: 20,
      entryKey: '000020#000000#TEAM#新規チーム-2',
    },
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  })
})

test('DynamoDB directory client creates duplicate named projects with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

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
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#新規プロジェクト',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: '新規プロジェクト',
              projectSortOrder: 10,
              nameJa: '新規プロジェクト',
              nameEn: 'New Project',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.createProject('user#demo@example.com', 'core-team', {
      name: '新規プロジェクト',
      tone: 'green',
    }),
  ).resolves.toEqual({
    project: {
      id: '新規プロジェクト-2',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      projectId: '新規プロジェクト-2',
      projectSortOrder: 20,
      entryKey: '000010#000020#PROJECT#新規プロジェクト-2',
    },
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  })
})

test('DynamoDB directory client initializes a missing local table before creating a team', async () => {
  const documentInputs: Array<Record<string, unknown>> = []
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      documentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryId', KeyType: 'HASH' },
              { AttributeName: 'entryKey', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectDirectoryClient(
    'MissingDirectoryTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.createTeam('user#demo@example.com', { name: '復旧チーム' })).resolves.toEqual({
    team: {
      id: '復旧チーム',
      name: '復旧チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingDirectoryTable',
      KeySchema: [
        { AttributeName: 'directoryId', KeyType: 'HASH' },
        { AttributeName: 'entryKey', KeyType: 'RANGE' },
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingDirectoryTable',
    }),
  ])
  expect(documentInputs.at(-1)).toMatchObject({
    TableName: 'MissingDirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '復旧チーム',
    },
  })
})

test('DynamoDB task client initializes a missing local table before reading tasks', async () => {
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'ProjectSortOrderIndex',
                KeySchema: [
                  { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
                  { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                ],
              },
            ],
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'MissingTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.getProjectTasks('user#demo@example.com', 'new-project')).resolves.toEqual({
    projectId: 'new-project',
    tasks: [],
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingTasksTable',
      KeySchema: [
        { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
        { AttributeName: 'taskId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'ProjectSortOrderIndex',
        }),
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingTasksTable',
    }),
  ])
})

test('DynamoDB task client fails fast when a local table exists with the wrong schema', async () => {
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1
        const error = new Error('missing index')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'CreateTableCommand') {
        const error = new Error('table exists')
        error.name = 'ResourceInUseException'
        throw error
      }

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'BrokenTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(
    client.getProjectTasks('user#demo@example.com', 'broken-project'),
  ).rejects.toThrow('does not match the expected schema')
  expect(queryAttempts).toBe(1)
})

test('creates a project task after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assignee: '佐藤 花子',
      dueDate: '2026/06/20',
      priority: 'high',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    task: {
      id: 'new-task',
      title: '新規タスク',
      assignee: '佐藤 花子',
      status: 'todo',
      dueDate: '2026/06/20',
      priority: 'high',
    },
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskCreates).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero', title: '新規タスク' },
  ])
})

test('DynamoDB task client queries the scoped project partition across pages', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              directoryProjectId: 'user#demo@example.com#project#refero',
              projectId: 'refero',
              taskId: 'wireframe',
              sortOrder: 10,
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
          LastEvaluatedKey: {
            directoryProjectId: 'user#demo@example.com#project#refero',
            taskId: 'wireframe',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            directoryProjectId: 'user#demo@example.com#project#refero',
            projectId: 'refero',
            taskId: 'brand-guideline',
            sortOrder: 20,
            titleKey: 'tasks.item.brandGuideline',
            assigneeKey: 'tasks.assignee.suzuki',
            status: 'review',
            dueDate: '2026/06/05',
            priority: 'medium',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(client.getProjectTasks('user#demo@example.com', 'refero')).resolves.toEqual({
    projectId: 'refero',
    tasks: [
      {
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
      {
        id: 'brand-guideline',
        titleKey: 'tasks.item.brandGuideline',
        assigneeKey: 'tasks.assignee.suzuki',
        status: 'review',
        dueDate: '2026/06/05',
        priority: 'medium',
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: {
        directoryProjectId: 'user#demo@example.com#project#refero',
        taskId: 'wireframe',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB dashboard summary client derives counts from directory and task data', async () => {
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory(directoryId, locale) {
        expect(directoryId).toBe('user#demo@example.com')
        expect(locale).toBe('ja')

        return {
          teams: [
            {
              id: 'core-team',
              name: 'コアチーム',
              expanded: true,
              projects: [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
                {
                  id: 'new-project',
                  name: '新規プロジェクト',
                  tone: 'green',
                },
              ],
            },
          ],
        }
      },
      async hasProjectAccess() {
        return true
      },
      async createTeam() {
        return {
          team: {
            id: 'unused',
            name: 'unused',
            projects: [],
          },
        }
      },
      async createProject() {
        return {
          project: {
            id: 'unused',
            name: 'unused',
          },
        }
      },
    },
    {
      async getProjectTasks(_directoryId, projectId) {
        return {
          projectId,
          tasks: projectId === 'refero'
            ? [
                {
                  id: 'wireframe',
                  title: 'ワイヤーフレーム',
                  assignee: '佐藤 花子',
                  status: 'in-progress',
                  dueDate: '2026/06/03',
                  priority: 'high',
                },
                {
                  id: 'archive',
                  title: '完了済み',
                  assignee: '鈴木 太郎',
                  status: 'done',
                  dueDate: '2026/06/01',
                  priority: 'high',
                },
              ]
            : [
                {
                  id: 'planning',
                  title: '計画',
                  assignee: '田中 一郎',
                  status: 'todo',
                  dueDate: '2026/06/12',
                  priority: 'medium',
                },
              ],
        }
      },
      async createProjectTask() {
        return {
          task: {
            id: 'unused',
            title: 'unused',
            assignee: 'unused',
            status: 'todo',
            dueDate: '2026/06/03',
            priority: 'medium',
          },
        }
      },
    },
  )

  const summary = await client.getSummary('user#demo@example.com')

  expect(summary.projects).toBe(2)
  expect(summary.tasks).toBe(2)
  expect(summary.blocked).toBe(1)
  expect(summary.source).toBe('dynamodb')
  expect(Date.parse(summary.updatedAt)).not.toBeNaN()
})

test('DynamoDB directory client reads every page from the user partition', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
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
          LastEvaluatedKey: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
            entryType: 'project',
            teamId: 'core-team',
            teamSortOrder: 10,
            projectId: 'refero',
            projectSortOrder: 10,
            nameJa: 'Refero',
            nameEn: 'Refero',
            tone: 'blue',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: {
        directoryId: 'user#demo@example.com',
        entryKey: '000010#000000#TEAM#core-team',
      },
      ScanIndexForward: true,
    },
  ])
})

function configureFakeProjectClients(hasProjectAccess: boolean) {
  const calls = {
    accessChecks: [] as Array<{ directoryId: string; projectId: string }>,
    directoryReads: [] as Array<{ directoryId: string; locale: string }>,
    projectCreates: [] as Array<{ directoryId: string; teamId: string; name: string }>,
    summaryReads: [] as string[],
    teamCreates: [] as Array<{ directoryId: string; name: string }>,
    taskCreates: [] as Array<{ directoryId: string; projectId: string; title: string }>,
    taskReads: [] as Array<{ directoryId: string; projectId: string }>,
  }

  configureApiClientsForTest({
    cognito: {
      async initiatePasswordAuth() {
        return {}
      },
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'Demo@Example.com',
            },
          ],
        }
      },
    },
    dashboardSummary: {
      async getSummary(directoryId) {
        calls.summaryReads.push(directoryId)

        return {
          projects: 1,
          tasks: 1,
          blocked: 0,
          updatedAt: '2026-06-03T00:00:00.000Z',
          source: 'dynamodb',
        }
      },
    },
    projectDirectory: {
      async getProjectDirectory(directoryId, locale) {
        calls.directoryReads.push({ directoryId, locale })

        return {
          teams: [
            {
              id: 'core-team',
              name: locale === 'en' ? 'Core Team' : 'コアチーム',
              expanded: true,
              projects: [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
              ],
            },
          ],
        }
      },
      async hasProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        return hasProjectAccess
      },
      async createTeam(directoryId, input) {
        calls.teamCreates.push({ directoryId, name: String(input.name) })

        return {
          team: {
            id: 'new-team',
            name: String(input.name),
            expanded: true,
            projects: [],
          },
        }
      },
      async createProject(directoryId, teamId, input) {
        calls.projectCreates.push({ directoryId, teamId, name: String(input.name) })

        return {
          project: {
            id: 'new-project',
            name: String(input.name),
            tone: 'green',
          },
        }
      },
    },
    projectTasks: {
      async getProjectTasks(directoryId, projectId) {
        calls.taskReads.push({ directoryId, projectId })

        return {
          projectId,
          tasks: [
            {
              id: 'wireframe',
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
        }
      },
      async createProjectTask(directoryId, projectId, input) {
        calls.taskCreates.push({ directoryId, projectId, title: String(input.title) })

        return {
          task: {
            id: 'new-task',
            title: String(input.title),
            assignee: String(input.assignee),
            status: 'todo',
            dueDate: String(input.dueDate),
            priority: 'high',
          },
        }
      },
    },
  })

  return calls
}
