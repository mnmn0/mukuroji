import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  resetTestApp,
  withTestEnvironment,
} = createApiTestHarness()
import {
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
} from './work-item-client'
import {
  createMutationAuditContext,
} from '../../../audit/audit'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
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
        source: 'legacy',
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
      {
        source: 'legacy',
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

test('DynamoDB task and Work Item list clients stop pagination at the requested read limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const legacyTask = {
    directoryId: 'user#demo@example.com',
    directoryProjectId: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    taskId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
  }
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Items: [command.input.TableName === 'LegacyTasksTable' ? legacyTask : canonicalWorkItem],
        LastEvaluatedKey: { more: true },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 1 })
  await workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 1 })
  await workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 1 })

  expect(sentInputs).toHaveLength(3)
  expect(sentInputs.map((input) => input.Limit)).toEqual([1, 1, 1])
})

test('DynamoDB task and Work Item list clients skip DynamoDB reads when limit is zero', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(
    projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ tasks: [] })
  await expect(
    workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  await expect(
    workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  expect(sentInputs).toEqual([])
})

test('DynamoDB Team Work Item reads can use the strongly consistent base table', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await client.getTeamIssues('user#demo@example.com', 'core-team', {
    consistentRead: true,
  })

  expect(sentInputs).toEqual([{
    TableName: 'WorkItemsTable',
    ConsistentRead: true,
    KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
    ExpressionAttributeValues: {
      ':directoryTeamId': 'user#demo@example.com#team#core-team',
    },
    ExclusiveStartKey: undefined,
  }])
})

test('DynamoDB Team and project Work Item clients read every page without a default Limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const pageCounts = new Map<string, number>()
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'work-item-1',
    sortOrder: 10,
    title: 'Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      const indexName = String(command.input.IndexName)
      const pageCount = (pageCounts.get(indexName) ?? 0) + 1
      pageCounts.set(indexName, pageCount)

      return {
        Items: [{
          ...canonicalWorkItem,
          issueId: `${indexName}-${pageCount}`,
          sortOrder: pageCount * 10,
        }],
        ...(pageCount === 1 ? { LastEvaluatedKey: { indexName, pageCount } } : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const teamResponse = await client.getTeamIssues(
    'user#demo@example.com',
    'core-team',
    { limit: undefined },
  )
  const projectResponse = await client.getProjectIssues(
    'user#demo@example.com',
    'refero',
    { limit: undefined },
  )

  expect(teamResponse.issues).toHaveLength(2)
  expect(projectResponse.issues).toHaveLength(2)
  expect(sentInputs).toHaveLength(4)
  expect(sentInputs.every((input) => !('Limit' in input))).toBe(true)
})

test('DynamoDB Work Item list limits count visible rows instead of archived rows', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const pageCounts = new Map<string, number>()
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'work-item',
    sortOrder: 10,
    title: 'Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      const indexName = String(command.input.IndexName)
      const pageCount = (pageCounts.get(indexName) ?? 0) + 1
      pageCounts.set(indexName, pageCount)
      return pageCount === 1
        ? {
            Items: [{
              ...canonicalWorkItem,
              issueId: `${indexName}-archived`,
              archivedAt: '2026-07-12T01:00:00.000Z',
            }],
            LastEvaluatedKey: { indexName, pageCount },
          }
        : {
            Items: [{
              ...canonicalWorkItem,
              issueId: `${indexName}-active`,
              sortOrder: 20,
            }],
          }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const teamResponse = await client.getTeamIssues(
    'user#demo@example.com',
    'core-team',
    { limit: 1 },
  )
  const projectResponse = await client.getProjectIssues(
    'user#demo@example.com',
    'refero',
    { limit: 1 },
  )

  expect(teamResponse.issues.map((issue) => issue.id)).toEqual([
    'TeamIssueSortOrderIndex-active',
  ])
  expect(projectResponse.issues.map((issue) => issue.id)).toEqual([
    'AssignedProjectIssueIndex-active',
  ])
  expect(sentInputs).toHaveLength(4)
  expect(sentInputs.map((input) => input.Limit)).toEqual([1, 1, 1, 1])
  expect(sentInputs[1]?.ExclusiveStartKey).toEqual({
    indexName: 'TeamIssueSortOrderIndex',
    pageCount: 1,
  })
  expect(sentInputs[3]?.ExclusiveStartKey).toEqual({
    indexName: 'AssignedProjectIssueIndex',
    pageCount: 1,
  })
})

test('DynamoDB Work Item creation allocates IDs and sort order across archived rows', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const archivedWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    archivedAt: '2026-07-12T01:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [archivedWorkItem] }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const response = await client.createTeamIssue(
    'user#demo@example.com',
    'core-team',
    {
      title: 'Wireframe',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      dueDate: '2026/06/03',
      priority: 'high',
    },
    'demo@example.com',
  )

  expect(response.issue.id).toBe('wireframe-2')
  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactionItems = (transaction?.input as TransactWriteCommandInput | undefined)
    ?.TransactItems
  expect(transactionItems?.[0]).toMatchObject({
    Put: {
      Item: {
        issueId: 'wireframe-2',
        sortOrder: 20,
      },
    },
  })
})

test('DynamoDB Work Item comment idempotent replay returns comment and activity', async () => {
  const issue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'issue-1',
    sortOrder: 10,
    title: 'Idempotent comments',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
  const existingComment = {
    directoryId: 'workspace-1',
    teamId: 'core-team',
    issueId: 'issue-1',
    directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
    eventId: 'automation-comment-1',
    eventType: 'commented',
    actorUserId: 'automation:rule-1',
    body: 'Already delivered',
    summary: 'Comment was added.',
    createdAt: '2026-07-17T00:01:00.000Z',
  }
  let getCount = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        getCount += 1
        return { Item: getCount === 1 ? issue : existingComment }
      }
      if (command.constructor.name === 'PutCommand') {
        const error = new Error('The comment already exists.')
        error.name = 'ConditionalCheckFailedException'
        throw error
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.createTeamIssueComment(
    'workspace-1',
    'core-team',
    'issue-1',
    {
      body: 'Already delivered',
      idempotencyEventId: 'automation-comment-1',
    },
    'automation:rule-1',
  )).resolves.toEqual({
    comment: {
      id: 'automation-comment-1',
      actorUserId: 'automation:rule-1',
      body: 'Already delivered',
      createdAt: '2026-07-17T00:01:00.000Z',
    },
    activity: {
      id: 'automation-comment-1',
      type: 'commented',
      actorUserId: 'automation:rule-1',
      summary: 'Comment was added.',
      createdAt: '2026-07-17T00:01:00.000Z',
    },
  })
  expect(getCount).toBe(2)
})

test('DynamoDB Work Item client increments revision with an atomic CAS update', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  let preparedResponse: unknown
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : {
                ...currentIssue,
                revision: 2,
                workflowStatusId: 'done',
                statusCategory: 'completed',
              },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    {
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
      customFieldValues: {},
      expectedRevision: 1,
    },
    'demo@example.com',
    undefined,
    {
      async prepare(response) {
        preparedResponse = response
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', value: { state: 'completed' } },
            },
          },
        }
      },
    },
  )).resolves.toMatchObject({
    issue: { schemaVersion: 1, revision: 2, workflowStatusId: 'done' },
  })
  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Update: {
      ExpressionAttributeValues: {
        ':expectedRevision': 1,
        ':nextRevision': 2,
      },
      ConditionExpression:
        'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
        '#revision = :expectedRevision',
    },
  })
  expect(Array.isArray(transactItems) ? transactItems.at(-1) : undefined).toMatchObject({
    Put: { TableName: 'DeveloperPlatformTable' },
  })
  expect(preparedResponse).toMatchObject({
    status: 200,
    body: { id: 'wireframe', revision: 2, workflowStatusId: 'done' },
  })
})

test('DynamoDB Work Item delete atomically stores its replay receipt', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 3,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'obsolete',
    sortOrder: 10,
    title: 'Obsolete',
    assigneeUserId: 'demo@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let preparedResponse: unknown
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.deleteTeamIssue(
    'workspace-1',
    'core-team',
    'obsolete',
    3,
    'demo@example.com',
    undefined,
    {
      async prepare(response) {
        preparedResponse = response
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', value: { state: 'completed' } },
            },
          },
        }
      },
    },
    [
      {
        kind: 'external-links',
        transactWriteItem: {
          Put: {
            TableName: 'DeveloperPlatformTable',
            Item: {
              entryType: 'work-item-link-fence',
              activeLinkCount: 0,
            },
          },
        },
      },
      {
        kind: 'document-backlinks',
        transactWriteItem: {
          Put: {
            TableName: 'DocumentsTable',
            Item: {
              entryType: 'work-item-document-backlink-fence',
              activeBacklinkCount: 0,
            },
          },
        },
      },
    ],
  )).resolves.toMatchObject({ issue: { id: 'obsolete', revision: 3 } })

  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Delete: {
      TableName: 'IssuesTable',
      ExpressionAttributeValues: { ':expectedRevision': 3 },
    },
  })
  expect(Array.isArray(transactItems) ? transactItems[1] : undefined).toMatchObject({
    Put: {
      TableName: 'DeveloperPlatformTable',
      Item: { entryType: 'work-item-link-fence', activeLinkCount: 0 },
    },
  })
  expect(Array.isArray(transactItems) ? transactItems[2] : undefined).toMatchObject({
    Put: {
      TableName: 'DocumentsTable',
      Item: {
        entryType: 'work-item-document-backlink-fence',
        activeBacklinkCount: 0,
      },
    },
  })
  expect(Array.isArray(transactItems) ? transactItems.at(-1) : undefined).toMatchObject({
    Put: { TableName: 'DeveloperPlatformTable' },
  })
  expect(preparedResponse).toEqual({ status: 204, body: null })
})

test('DynamoDB Work Item client classifies configuration conflicts from the actual transaction layout', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'configuration-conflict',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'configuration-conflict' },
  })
  const configurationConditionChecks: NonNullable<
    TransactWriteCommandInput['TransactItems']
  > = [{
    ConditionCheck: {
      TableName: 'ConfigurationTable',
      Key: { workspaceId: 'workspace-1', scopeKey: 'WORK_ITEM_CONFIGURATION#TEAM#core-team' },
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    },
  }]

  for (const operation of ['create', 'update'] as const) {
    for (const auditEnabled of [false, true]) {
      let configurationConditionIndex = -1
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'QueryCommand') {
            return { Items: [] }
          }
          if (command.constructor.name === 'GetCommand') {
            return { Item: currentIssue }
          }
          if (command.constructor.name === 'TransactWriteCommand') {
            const transactItems = command.input.TransactItems as Array<{
              ConditionCheck?: { TableName?: string }
            }>
            configurationConditionIndex = transactItems.findIndex((item) =>
              item.ConditionCheck?.TableName === 'ConfigurationTable'
            )
            const error = new Error('Transaction was canceled.')
            error.name = 'TransactionCanceledException'
            Object.assign(error, {
              CancellationReasons: transactItems.map((_, index) => ({
                Code: index === configurationConditionIndex ? 'ConditionalCheckFailed' : 'None',
              })),
            })
            throw error
          }
          return {}
        },
      } as unknown as DynamoDBDocumentClient
      const client = new DynamoDbTeamIssuesClient(
        'IssuesTable',
        'IssueEventsTable',
        documentClient,
        {} as DynamoDBClient,
        false,
        auditEnabled ? 'AuditTable' : undefined,
      )
      const mutation = operation === 'create'
        ? client.createTeamIssue(
            'workspace-1',
            'core-team',
            {
              title: 'New Work Item',
              assigneeUserId: 'sato@example.com',
              workflowSchemaVersion: 1,
              workflowStatusId: 'todo',
              statusCategory: 'unstarted',
              customFieldValues: {},
              dueDate: '2026/07/20',
              priority: 'medium',
              configurationConditionChecks,
            },
            'demo@example.com',
            auditEnabled ? auditContext : undefined,
          )
        : client.updateTeamIssue(
            'workspace-1',
            'core-team',
            'wireframe',
            {
              workflowSchemaVersion: 1,
              workflowStatusId: 'done',
              statusCategory: 'completed',
              customFieldValues: {},
              expectedRevision: 1,
              configurationConditionChecks,
            },
            'demo@example.com',
            auditEnabled ? auditContext : undefined,
          )

      await expect(mutation).rejects.toMatchObject({
        code: 'WorkItemConfigurationRevisionConflict',
        status: 409,
      })
      expect(configurationConditionIndex).toBe(auditEnabled ? 3 : 2)
    }
  }
})

test('DynamoDB Work Item client compiles authorization snapshots inside the adapter', async () => {
  await withTestEnvironment({
    MUKUROJI_WORKSPACE_ACCESS_TABLE: 'WorkspaceAccessTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
  }, async () => {
    let transactItems: TransactWriteCommandInput['TransactItems']
    const documentClient = {
      async send(command: { input: TransactWriteCommandInput; constructor: { name: string } }) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        if (command.constructor.name === 'TransactWriteCommand') {
          transactItems = command.input.TransactItems
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
    )

    await client.createTeamIssue(
      'workspace-1',
      'core-team',
      {
        title: 'Snapshot-protected Work Item',
        assigneeUserId: 'sato@example.com',
        workflowSchemaVersion: 1,
        workflowStatusId: 'todo',
        statusCategory: 'unstarted',
        customFieldValues: {},
        dueDate: '2026/07/20',
        priority: 'medium',
        authorizationSnapshot: {
          workspaceId: 'workspace-1',
          memberKey: 'Demo@Example.com',
          workspaceMemberVersion: 7,
          planningRevision: 0,
          enterpriseControlRevision: 3,
        },
      },
      'demo@example.com',
    )

    expect(transactItems?.slice(2)).toEqual([
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'workspace-1',
            recordKey: 'MEMBER#demo@example.com',
          },
          ExpressionAttributeValues: expect.objectContaining({
            ':authorization2': 7,
          }),
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'PlanningTable',
          Key: {
            workspaceId: 'workspace-1',
            recordKey: 'META',
          },
          ConditionExpression: expect.stringContaining('attribute_not_exists'),
          ExpressionAttributeValues: expect.objectContaining({
            ':authorization1': 0,
          }),
        }),
      },
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'EnterpriseIdentityTable',
          Key: {
            scopeKey: 'WORKSPACE#workspace-1',
            recordKey: 'CONTROL',
          },
          ExpressionAttributeValues: expect.objectContaining({
            ':authorization0': 3,
          }),
        }),
      },
    ])
  })
})

test('DynamoDB Work Item mutations classify authorization snapshot races separately', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'authorization-race',
    sortOrder: 10,
    title: 'Authorization race',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const authorizationConditionChecks: NonNullable<
    TransactWriteCommandInput['TransactItems']
  > = [{
    ConditionCheck: {
      TableName: 'WorkspaceAccessTable',
      Key: {
        workspaceId: 'workspace-1',
        recordKey: 'MEMBER#demo@example.com',
      },
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': 1 },
    },
  }]

  for (const operation of ['create', 'update'] as const) {
    let authorizationConditionIndex = -1
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        if (command.constructor.name === 'QueryCommand') return { Items: [] }
        if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
        if (command.constructor.name === 'TransactWriteCommand') {
          const transactItems = command.input.TransactItems as Array<{
            ConditionCheck?: { TableName?: string }
          }>
          authorizationConditionIndex = transactItems.findIndex((item) =>
            item.ConditionCheck?.TableName === 'WorkspaceAccessTable'
          )
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'
          Object.assign(error, {
            CancellationReasons: transactItems.map((_, index) => ({
              Code: index === authorizationConditionIndex
                ? 'ConditionalCheckFailed'
                : 'None',
            })),
          })
          throw error
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
    )
    const mutation = operation === 'create'
      ? client.createTeamIssue(
          'workspace-1',
          'core-team',
          {
            title: 'New Work Item',
            assigneeUserId: 'sato@example.com',
            workflowSchemaVersion: 1,
            workflowStatusId: 'todo',
            statusCategory: 'unstarted',
            customFieldValues: {},
            dueDate: '2026/07/20',
            priority: 'medium',
            authorizationConditionChecks,
          },
          'demo@example.com',
        )
      : client.updateTeamIssue(
          'workspace-1',
          'core-team',
          'authorization-race',
          {
            workflowSchemaVersion: 1,
            workflowStatusId: 'done',
            statusCategory: 'completed',
            customFieldValues: {},
            expectedRevision: 1,
            authorizationConditionChecks,
          },
          'demo@example.com',
        )

    await expect(mutation).rejects.toMatchObject({
      code: 'WorkItemAuthorizationChanged',
      status: 409,
    })
    expect(authorizationConditionIndex).toBe(2)
  }

  let deleteAuthorizationConditionIndex = -1
  const deleteDocumentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
      if (command.constructor.name === 'TransactWriteCommand') {
        const transactItems = command.input.TransactItems as Array<{
          ConditionCheck?: { TableName?: string }
        }>
        deleteAuthorizationConditionIndex = transactItems.findIndex((item) =>
          item.ConditionCheck?.TableName === 'WorkspaceAccessTable'
        )
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: transactItems.map((_, index) => ({
            Code: index === deleteAuthorizationConditionIndex
              ? 'ConditionalCheckFailed'
              : 'None',
          })),
        })
        throw error
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const deleteClient = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    deleteDocumentClient,
    {} as DynamoDBClient,
    false,
  )
  await expect(deleteClient.deleteTeamIssue(
    'workspace-1',
    'core-team',
    'authorization-race',
    1,
    'demo@example.com',
    undefined,
    undefined,
    [
      {
        kind: 'external-links',
        transactWriteItem: {
          Put: { TableName: 'DeveloperPlatformTable', Item: { activeLinkCount: 0 } },
        },
      },
      {
        kind: 'document-backlinks',
        transactWriteItem: {
          Put: { TableName: 'DocumentsTable', Item: { activeBacklinkCount: 0 } },
        },
      },
    ],
    authorizationConditionChecks,
  )).rejects.toMatchObject({
    code: 'WorkItemAuthorizationChanged',
    status: 409,
  })
  expect(deleteAuthorizationConditionIndex).toBe(3)
})

test('DynamoDB Work Item delete distinguishes external-link and Document-backlink races', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'deletion-fence-race',
    sortOrder: 10,
    title: 'Deletion fence race',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const fences = [
    {
      kind: 'external-links' as const,
      transactWriteItem: {
        Put: { TableName: 'DeveloperPlatformTable', Item: { activeLinkCount: 0 } },
      },
    },
    {
      kind: 'document-backlinks' as const,
      transactWriteItem: {
        Put: { TableName: 'DocumentsTable', Item: { activeBacklinkCount: 0 } },
      },
    },
  ]
  for (const [failedIndex, expectedCode] of [
    [1, 'ExternalWorkItemLinkConflict'],
    [2, 'WorkItemDocumentBacklinkConflict'],
  ] as const) {
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
        if (command.constructor.name === 'TransactWriteCommand') {
          const transactItems =
            command.input.TransactItems as NonNullable<TransactWriteCommandInput['TransactItems']>
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'
          Object.assign(error, {
            CancellationReasons: transactItems.map((_, index) => ({
              Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None',
            })),
          })
          throw error
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
    )

    await expect(client.deleteTeamIssue(
      'workspace-1',
      'core-team',
      'deletion-fence-race',
      1,
      'demo@example.com',
      undefined,
      undefined,
      fences,
    )).rejects.toMatchObject({
      code: expectedCode,
      status: 409,
    })
  }
})

test('DynamoDB Work Item delete maps unclassified transaction cancellations to a retryable error', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'unclassified-cancellation',
    sortOrder: 10,
    title: 'Unclassified cancellation',
    assigneeUserId: 'demo@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  for (const cancellationReasons of [
    undefined,
    [],
    [{ Code: 'TransactionConflict' }],
  ]) {
    const documentClient = {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
        if (command.constructor.name === 'TransactWriteCommand') {
          const error = Object.assign(new Error('Transaction was canceled.'), {
            name: 'TransactionCanceledException',
            $metadata: { httpStatusCode: 400 },
          })
          if (cancellationReasons !== undefined) {
            Object.assign(error, { CancellationReasons: cancellationReasons })
          }
          throw error
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
    )

    await expect(client.deleteTeamIssue(
      'workspace-1',
      'core-team',
      'unclassified-cancellation',
      1,
      'demo@example.com',
    )).rejects.toMatchObject({
      code: 'WorkItemDeletionTransactionUnavailable',
      status: 503,
    })
  }
})

test('DynamoDB Work Item delete prioritizes authorization failure over deletion fences', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'multiple-condition-failures',
    sortOrder: 10,
    title: 'Multiple condition failures',
    assigneeUserId: 'demo@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
      if (command.constructor.name === 'TransactWriteCommand') {
        const transactItems =
          command.input.TransactItems as NonNullable<TransactWriteCommandInput['TransactItems']>
        const authorizationIndex = transactItems.findIndex((item) =>
          item.ConditionCheck?.TableName === 'WorkspaceAccessTable'
        )
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: transactItems.map((_, index) => ({
            Code: index === 1 || index === authorizationIndex
              ? 'ConditionalCheckFailed'
              : 'None',
          })),
        })
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.deleteTeamIssue(
    'workspace-1',
    'core-team',
    'multiple-condition-failures',
    1,
    'demo@example.com',
    undefined,
    undefined,
    [{
      kind: 'external-links',
      transactWriteItem: {
        Put: {
          TableName: 'DeveloperPlatformTable',
          Item: { activeLinkCount: 0 },
        },
      },
    }],
    [{
      ConditionCheck: {
        TableName: 'WorkspaceAccessTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#demo@example.com' },
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 1 },
      },
    }],
  )).rejects.toMatchObject({
    code: 'WorkItemAuthorizationChanged',
    status: 409,
  })
})

test('DynamoDB Work Item update emits render-ready notification candidates', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Notification-ready Work Item',
    assigneeUserId: 'before@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : {
                ...currentIssue,
                revision: 2,
                assigneeUserId: 'after@example.com',
                workflowStatusId: 'review',
                statusCategory: 'started',
              },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'manager-sub', kind: 'user', displayName: 'manager@example.com' },
    idempotencyKey: 'notification-update',
    occurredAt: '2026-07-12T01:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'notification-update' },
  })
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await client.updateTeamIssue(
    'workspace-1',
    'core-team',
    'wireframe',
    {
      assigneeUserId: 'after@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'review',
      statusCategory: 'started',
      customFieldValues: {},
      expectedRevision: 1,
    },
    'manager@example.com',
    auditContext,
  )

  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  const auditItem = Array.isArray(transactItems)
    ? (transactItems[2] as { Put?: { Item?: Record<string, unknown> } })?.Put?.Item
    : undefined

  expect(auditItem).toMatchObject({
    eventType: 'work-item.updated',
    summary: 'Work Item assignment changed.',
    metadata: {
      actorMemberKey: 'manager@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
      projectId: 'refero',
      deepLink: '/teams/core-team/issues?issueId=wireframe',
      notificationTitle: 'Notification-ready Work Item',
      notificationCandidates: [
        { memberKey: 'after@example.com', reason: 'assignment' },
        { memberKey: 'after@example.com', reason: 'status-change' },
      ],
    },
  })
})

test('DynamoDB Work Item client classifies revision CAS transaction conditions', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'request-1' },
  })
  const runUpdate = (
    cancellationReasons: Array<{ Code: string }> | undefined,
    latestIssue: Record<string, unknown> | undefined,
  ) => {
    const sentInputs: Array<Record<string, unknown>> = []
    let issueReads = 0
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        sentInputs.push(command.input)

        if (command.constructor.name === 'GetCommand') {
          issueReads += 1
          return { Item: issueReads === 1 ? currentIssue : latestIssue }
        }

        if (command.constructor.name === 'TransactWriteCommand') {
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'

          if (cancellationReasons) {
            Object.assign(error, { CancellationReasons: cancellationReasons })
          }

          throw error
        }

        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    )
    const result = client.updateTeamIssue(
      'user#demo@example.com',
      'core-team',
      'wireframe',
      {
        workflowSchemaVersion: 1,
        workflowStatusId: 'done',
        statusCategory: 'completed',
        customFieldValues: {},
        expectedRevision: 1,
      },
      'demo@example.com',
      auditContext,
    )

    return { result, sentInputs }
  }

  const stateConflict = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    { ...currentIssue, revision: 2 },
  )
  await expect(stateConflict.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(stateConflict.sentInputs[0]).toMatchObject({
    TableName: 'IssuesTable',
    ConsistentRead: true,
  })
  expect(stateConflict.sentInputs.at(-1)).toMatchObject({
    TableName: 'IssuesTable',
    Key: {
      directoryTeamId: 'user#demo@example.com#team#core-team',
      issueId: 'wireframe',
    },
    ConsistentRead: true,
  })

  const auditConflict = runUpdate(
    [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    currentIssue,
  )
  await expect(auditConflict.result).rejects.toMatchObject({
    code: 'ConditionalCheckFailedException',
    status: 409,
  })
  expect(auditConflict.sentInputs).toHaveLength(2)

  const deletedIssue = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    undefined,
  )
  await expect(deletedIssue.result).rejects.toMatchObject({
    code: 'TeamIssueNotFound',
    status: 404,
  })

  const missingReasons = runUpdate(undefined, { ...currentIssue, revision: 2 })
  await expect(missingReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(missingReasons.sentInputs).toHaveLength(3)

  const missingReasonsWithoutRevisionChange = runUpdate(undefined, currentIssue)
  await expect(missingReasonsWithoutRevisionChange.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(missingReasonsWithoutRevisionChange.sentInputs).toHaveLength(3)

  const emptyReasons = runUpdate([], { ...currentIssue, revision: 2 })
  await expect(emptyReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(emptyReasons.sentInputs).toHaveLength(3)

  const unknownReason = runUpdate([{ Code: 'TransactionConflict' }], undefined)
  await expect(unknownReason.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(unknownReason.sentInputs).toHaveLength(2)

  const mixedReasons = runUpdate(
    [
      { Code: 'ConditionalCheckFailed' },
      { Code: 'ProvisionedThroughputExceeded' },
      { Code: 'None' },
    ],
    undefined,
  )
  await expect(mixedReasons.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(mixedReasons.sentInputs).toHaveLength(2)
})
