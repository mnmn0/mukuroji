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
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  afterEach,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  WORK_ITEM_SCHEMA_VERSION,
  type DueDateWorkItemSchedule,
} from '@mukuroji/contracts'

afterEach(() => {
  resetTestApp()
})

/** Creates a canonical deadline-only schedule for DynamoDB Work Item fixtures. */
function createDueDateSchedule(dueDate: string): DueDateWorkItemSchedule {
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

/**
 * Creates one strict persisted Work Item used by schedule cascade transaction tests.
 *
 * @param teamId - Owning Team identifier.
 * @param issueId - Team-local Work Item identifier.
 * @returns Canonical DynamoDB fixture row at revision one.
 */
function createScheduleCascadeIssue(teamId: string, issueId: string) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: `workspace-1#team#${teamId}`,
    directoryProjectId: 'workspace-1#project#refero',
    teamId,
    assignedProjectId: 'refero',
    issueId,
    sortOrder: 10,
    title: `Cascade ${issueId}`,
    assigneeUserId: 'demo@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
}

/** Checks a mock AWS command fragment before reading nested transaction values. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the Work Item put item from a captured DynamoDB transaction. */
function readTransactionPutItem(
  input: Record<string, unknown>,
  tableName: string,
): Record<string, unknown> | undefined {
  const transactItems = input.TransactItems
  if (!Array.isArray(transactItems)) {
    return undefined
  }
  for (const transactItem of transactItems) {
    if (!isUnknownRecord(transactItem) || !isUnknownRecord(transactItem.Put)) {
      continue
    }
    if (
      transactItem.Put.TableName === tableName &&
      isUnknownRecord(transactItem.Put.Item)
    ) {
      return structuredClone(transactItem.Put.Item)
    }
  }
  return undefined
}

/** Reads the Work Item update expression values from a captured DynamoDB transaction. */
function readTransactionUpdateValues(
  input: Record<string, unknown>,
  tableName: string,
): Record<string, unknown> | undefined {
  const transactItems = input.TransactItems
  if (!Array.isArray(transactItems)) {
    return undefined
  }
  for (const transactItem of transactItems) {
    if (!isUnknownRecord(transactItem) || !isUnknownRecord(transactItem.Update)) {
      continue
    }
    if (
      transactItem.Update.TableName === tableName &&
      isUnknownRecord(transactItem.Update.ExpressionAttributeValues)
    ) {
      return structuredClone(transactItem.Update.ExpressionAttributeValues)
    }
  }
  return undefined
}

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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
              archivedBy: 'demo@example.com',
              updatedAt: '2026-07-12T01:00:00.000Z',
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T01:00:00.000Z',
    archivedAt: '2026-07-12T01:00:00.000Z',
    archivedBy: 'demo@example.com',
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
      schedule: createDueDateSchedule('2026-06-03'),
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
        schemaVersion: 2,
        dueDate: '2026-06-03',
        schedule: {
          mode: 'due-date',
          dueDate: '2026-06-03',
        },
      },
    },
  })
})

test('DynamoDB Work Item persists and re-reads explicit schedule replacements', async () => {
  let persistedItem: Record<string, unknown> | undefined
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: persistedItem ? [persistedItem] : [] }
      }
      if (command.constructor.name === 'GetCommand') {
        return { Item: persistedItem }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const putItem = readTransactionPutItem(command.input, 'WorkItemsTable')
        if (putItem) {
          persistedItem = putItem
        }
        const updateValues = readTransactionUpdateValues(command.input, 'WorkItemsTable')
        if (persistedItem && updateValues) {
          persistedItem = {
            ...persistedItem,
            schemaVersion: updateValues[':schemaVersion'],
            revision: updateValues[':nextRevision'],
            updatedAt: updateValues[':updatedAt'],
            dueDate: updateValues[':dueDate'],
            schedule: updateValues[':schedule'],
          }
        }
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
  const dateRangeSchedule = {
    mode: 'date-range',
    startDate: '2026-08-03',
    endDate: '2026-08-07',
    durationDays: 5,
    plannedEffortMinutes: 1_800,
    calendarPolicy: {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: ['2026-08-11'],
    },
  }

  const created = await client.createTeamIssue(
    'user#demo@example.com',
    'core-team',
    {
      title: 'Scheduled Work Item',
      assigneeUserId: 'sato@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: dateRangeSchedule,
      priority: 'high',
    },
    'demo@example.com',
  )

  expect(created.issue).toMatchObject({
    schemaVersion: 2,
    dueDate: '2026-08-07',
    schedule: dateRangeSchedule,
  })
  await expect(client.getTeamIssueDetail(
    'user#demo@example.com',
    'core-team',
    created.issue.id,
    { consistentIssueRead: true, eventLimit: 0 },
  )).resolves.toMatchObject({
    issue: {
      dueDate: '2026-08-07',
      schedule: dateRangeSchedule,
    },
  })

  const milestoneSchedule = {
    mode: 'milestone',
    startDate: '2026-08-12',
    endDate: '2026-08-12',
    durationDays: 0,
    plannedEffortMinutes: 60,
    calendarPolicy: {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: ['2026-08-11'],
    },
  }
  const updated = await client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    created.issue.id,
    {
      expectedRevision: 1,
      schedule: milestoneSchedule,
    },
    'demo@example.com',
  )

  expect(updated.issue).toMatchObject({
    schemaVersion: 2,
    revision: 2,
    dueDate: '2026-08-12',
    schedule: milestoneSchedule,
  })
  await expect(client.getTeamIssueDetail(
    'user#demo@example.com',
    'core-team',
    created.issue.id,
    { consistentIssueRead: true, eventLimit: 0 },
  )).resolves.toMatchObject({
    issue: {
      revision: 2,
      dueDate: '2026-08-12',
      schedule: milestoneSchedule,
    },
  })

  const deadlineUpdated = await client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    created.issue.id,
    {
      expectedRevision: 2,
      schedule: {
        calendarPolicy: milestoneSchedule.calendarPolicy,
        dueDate: '2026-08-13',
        mode: 'due-date',
        plannedEffortMinutes: 60,
      },
    },
    'demo@example.com',
  )

  expect(deadlineUpdated.issue).toMatchObject({
    dueDate: '2026-08-13',
    revision: 3,
    schedule: {
      calendarPolicy: milestoneSchedule.calendarPolicy,
      dueDate: '2026-08-13',
      mode: 'due-date',
      plannedEffortMinutes: 60,
    },
  })
})

test('DynamoDB Work Item writes reject invalid schedules before persistence', async () => {
  const dynamoDbClient = new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'us-east-1',
  })
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient)
  const sendSpy = spyOn(documentClient, 'send')
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    dynamoDbClient,
    false,
  )
  const expectedFailure = {
    code: 'InvalidWorkItemScheduleDate',
    status: 400,
  }

  await expect(client.createTeamIssue(
    'user#demo@example.com',
    'core-team',
    {
      title: 'Impossible date',
      assigneeUserId: 'sato@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: '2026-02-29',
        mode: 'due-date',
      },
      priority: 'high',
    },
    'demo@example.com',
  )).rejects.toMatchObject(expectedFailure)
  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'impossible-date',
    {
      expectedRevision: 1,
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: '2026-02-29',
        mode: 'due-date',
      },
    },
    'demo@example.com',
  )).rejects.toMatchObject(expectedFailure)
  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'impossible-duration',
    {
      expectedRevision: 1,
      schedule: {
        mode: 'date-range',
        startDate: '2026-08-03',
        endDate: '2026-08-07',
        durationDays: 4,
        calendarPolicy: {
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          holidays: [],
        },
      },
    },
    'demo@example.com',
  )).rejects.toMatchObject({
    code: 'WorkItemScheduleDurationMismatch',
    status: 400,
  })

  expect(sendSpy).not.toHaveBeenCalled()
  documentClient.destroy()
})

test('DynamoDB Work Item archive updates reject timestamps outside the canonical window', async () => {
  const commandNames: string[] = []
  const currentIssue = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    teamId: 'core-team',
    issueId: 'archive-window',
    sortOrder: 10,
    title: 'Archive window',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      commandNames.push(command.constructor.name)
      return { Item: currentIssue }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const expectedFailure = {
    code: 'InvalidProjectWrite',
    message: 'Issue archive timestamp is invalid.',
    status: 400,
  }

  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'archive-window',
    {
      archivedAt: '2026-07-11T23:59:59.999Z',
      expectedRevision: 1,
    },
    'demo@example.com',
  )).rejects.toMatchObject(expectedFailure)
  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'archive-window',
    {
      archivedAt: '+010000-01-01T00:00:00.000Z',
      expectedRevision: 1,
    },
    'demo@example.com',
  )).rejects.toMatchObject(expectedFailure)
  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'archive-window',
    {
      archivedAt: currentIssue.createdAt,
      expectedRevision: 1,
    },
    'demo@example.com',
  )).resolves.toMatchObject({
    issue: {
      archivedAt: currentIssue.createdAt,
      archivedBy: 'demo@example.com',
    },
  })

  expect(commandNames).toEqual([
    'GetCommand',
    'GetCommand',
    'GetCommand',
    'TransactWriteCommand',
  ])
})

test('DynamoDB Work Item comment idempotent replay returns comment and activity', async () => {
  const issue = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
      schedule: createDueDateSchedule('2026-06-05'),
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
    issue: {
      schemaVersion: 2,
      revision: 2,
      workflowStatusId: 'done',
      dueDate: '2026-06-05',
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-05',
      },
    },
  })
  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Update: {
      ExpressionAttributeValues: {
        ':expectedRevision': 1,
        ':nextRevision': 2,
        ':dueDate': '2026-06-05',
        ':schedule': {
          mode: 'due-date',
          dueDate: '2026-06-05',
        },
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
              schedule: createDueDateSchedule('2026-07-20'),
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
        schedule: createDueDateSchedule('2026-07-20'),
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

test('DynamoDB Work Item updates compile and classify app-owned Planning revision fences', async () => {
  await withTestEnvironment({ PLANNING_TABLE_NAME: 'PlanningTable' }, async () => {
    const currentIssue = createScheduleCascadeIssue('core-team', 'planning-fence')

    for (const shouldFail of [false, true]) {
      let planningConditionIndex = -1
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
          if (command.constructor.name === 'TransactWriteCommand') {
            const transactItems = command.input.TransactItems as Array<{
              ConditionCheck?: { TableName?: string }
            }>
            planningConditionIndex = transactItems.findIndex((item) =>
              item.ConditionCheck?.TableName === 'PlanningTable'
            )
            expect(transactItems.filter((item) => item.ConditionCheck)).toHaveLength(1)
            expect(transactItems[planningConditionIndex]).toEqual({
              ConditionCheck: expect.objectContaining({
                TableName: 'PlanningTable',
                Key: { workspaceId: 'workspace-1', recordKey: 'META' },
                ExpressionAttributeValues: expect.objectContaining({
                  ':authorization1': 4,
                }),
              }),
            })
            if (shouldFail) {
              const error = new Error('Transaction was canceled.')
              error.name = 'TransactionCanceledException'
              Object.assign(error, {
                CancellationReasons: transactItems.map((_, index) => ({
                  Code: index === planningConditionIndex
                    ? 'ConditionalCheckFailed'
                    : 'None',
                })),
              })
              throw error
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
      const mutation = client.updateTeamIssue(
        'workspace-1',
        'core-team',
        'planning-fence',
        {
          expectedRevision: 1,
          schedule: createDueDateSchedule('2026-07-21'),
          planningRevisionFence: { expectedRevision: 4 },
        },
        'automation:rule-1',
      )

      if (shouldFail) {
        await expect(mutation).rejects.toMatchObject({
          code: 'WorkItemAuthorizationChanged',
          status: 409,
        })
      } else {
        await expect(mutation).resolves.toMatchObject({
          issue: { revision: 2, dueDate: '2026-07-21' },
        })
      }
      expect(planningConditionIndex).toBe(2)
    }
  })
})

test('DynamoDB Work Item mutations classify authorization snapshot races separately', async () => {
  const currentIssue = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
  const configurationConditionChecks: NonNullable<
    TransactWriteCommandInput['TransactItems']
  > = [{
    ConditionCheck: {
      TableName: 'ConfigurationTable',
      Key: { workspaceId: 'workspace-1', recordKey: 'CONFIGURATION#core-team' },
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    },
  }]

  for (const operation of ['create', 'update'] as const) {
    let authorizationConditionIndex = -1
    let configurationConditionIndex = -1
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
          configurationConditionIndex = transactItems.findIndex((item) =>
            item.ConditionCheck?.TableName === 'ConfigurationTable'
          )
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'
          Object.assign(error, {
            CancellationReasons: transactItems.map((_, index) => ({
              Code: index === authorizationConditionIndex ||
                  index === configurationConditionIndex
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
            schedule: createDueDateSchedule('2026-07-20'),
            priority: 'medium',
            configurationConditionChecks,
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
            configurationConditionChecks,
            authorizationConditionChecks,
          },
          'demo@example.com',
        )

    await expect(mutation).rejects.toMatchObject({
      code: 'WorkItemAuthorizationChanged',
      status: 409,
    })
    expect(configurationConditionIndex).toBe(2)
    expect(authorizationConditionIndex).toBe(3)
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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

test('DynamoDB Work Item schedule cascade writes one bounded transaction with unique events', async () => {
  await withTestEnvironment({
    MUKUROJI_WORKSPACE_ACCESS_TABLE: 'WorkspaceAccessTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
  }, async () => {
    const issues = new Map([
      ['core-team\0root', createScheduleCascadeIssue('core-team', 'root')],
      ['other-team\0successor', createScheduleCascadeIssue('other-team', 'successor')],
    ])
    const auditContext = createMutationAuditContext({
      workspaceId: 'workspace-1',
      actor: { id: 'demo@example.com', kind: 'user' },
      idempotencyKey: 'cascade-shape',
      occurredAt: '2026-07-12T00:00:00.000Z',
      request: { method: 'POST', path: '/schedule/confirm' },
      source: { kind: 'api', requestId: 'cascade-shape' },
    })
    const relationChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
      ConditionCheck: {
        TableName: 'ConfigurationTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'RELATION#core-team' },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': 4 },
      },
    }]

    for (const auditEnabled of [false, true]) {
      const transactions: NonNullable<TransactWriteCommandInput['TransactItems']>[] = []
      let preparedResponse: unknown
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'GetCommand') {
            const key = isUnknownRecord(command.input.Key) ? command.input.Key : {}
            const directoryTeamId = typeof key.directoryTeamId === 'string'
              ? key.directoryTeamId
              : ''
            const teamId = directoryTeamId.split('#team#')[1] ?? ''
            const issueId = typeof key.issueId === 'string' ? key.issueId : ''
            return { Item: issues.get(`${teamId}\0${issueId}`) }
          }
          if (command.constructor.name === 'TransactWriteCommand') {
            const items = command.input.TransactItems
            if (Array.isArray(items)) {
              transactions.push(items as NonNullable<TransactWriteCommandInput['TransactItems']>)
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
        auditEnabled ? 'AuditTable' : undefined,
      )

      await client.updateTeamIssueSchedules(
        'workspace-1',
        [
          {
            teamId: 'core-team',
            workItemId: 'root',
            expectedRevision: 1,
            schedule: createDueDateSchedule('2026-07-21'),
          },
          {
            teamId: 'other-team',
            workItemId: 'successor',
            expectedRevision: 1,
            schedule: createDueDateSchedule('2026-07-22'),
          },
        ],
        [{ teamId: 'guard-team', workItemId: 'fan-in', expectedRevision: 7 }],
        'demo@example.com',
        auditEnabled ? auditContext : undefined,
        relationChecks,
        {
          workspaceId: 'workspace-1',
          memberKey: 'demo@example.com',
          workspaceMemberVersion: 3,
          planningRevision: 8,
          enterpriseControlRevision: 5,
        },
        {
          async prepare(response) {
            preparedResponse = response
            return {
              transactWriteItem: {
                Put: {
                  TableName: 'DeveloperPlatformTable',
                  Item: { entryType: 'idempotency', state: 'completed' },
                },
              },
            }
          },
        },
      )

      expect(transactions).toHaveLength(1)
      const transactItems = transactions[0] ?? []
      expect(transactItems).toHaveLength(auditEnabled ? 12 : 10)
      expect(transactItems.filter((item) => item.Update?.TableName === 'IssuesTable'))
        .toHaveLength(2)
      expect(transactItems).toContainEqual(expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: 'IssuesTable',
          Key: { directoryTeamId: 'workspace-1#team#guard-team', issueId: 'fan-in' },
        }),
      }))
      for (const tableName of [
        'ConfigurationTable',
        'WorkspaceAccessTable',
        'PlanningTable',
        'EnterpriseIdentityTable',
      ]) {
        expect(transactItems).toContainEqual(expect.objectContaining({
          ConditionCheck: expect.objectContaining({ TableName: tableName }),
        }))
      }
      const eventItems = transactItems.flatMap((item) =>
        item.Put?.TableName === 'IssueEventsTable' && item.Put.Item
          ? [item.Put.Item]
          : []
      )
      expect(eventItems).toHaveLength(2)
      expect(new Set(eventItems.map((item) => item.eventId)).size).toBe(2)
      const auditItems = transactItems.flatMap((item) =>
        item.Put?.TableName === 'AuditTable' && item.Put.Item
          ? [item.Put.Item]
          : []
      )
      expect(auditItems).toHaveLength(auditEnabled ? 2 : 0)
      expect(new Set(auditItems.map((item) => item.eventId)).size).toBe(auditItems.length)
      expect(transactItems.at(-1)).toMatchObject({
        Put: { TableName: 'DeveloperPlatformTable' },
      })
      expect(preparedResponse).toMatchObject({
        status: 200,
        body: {
          workItems: [
            { id: 'root', revision: 2, dueDate: '2026-07-21' },
            { id: 'successor', revision: 2, dueDate: '2026-07-22' },
          ],
        },
      })
    }
  })
})

test('DynamoDB Work Item schedule cascade keeps the maximum valid receipt compact', async () => {
  const updates = Array.from({ length: 24 }, (_, index) => ({
    teamId: `team-${index}`,
    workItemId: `work-item-${index}`,
    expectedRevision: 1,
    schedule: createDueDateSchedule('2026-07-21'),
  }))
  const largeText = 'あ'.repeat(10_000)
  const issues = new Map(updates.map((update) => [
    `${update.teamId}\0${update.workItemId}`,
    {
      ...createScheduleCascadeIssue(update.teamId, update.workItemId),
      description: largeText,
      customFieldValues: { notes: largeText },
    },
  ]))
  let preparedResponse: unknown
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        const key = isUnknownRecord(command.input.Key) ? command.input.Key : {}
        const directoryTeamId = typeof key.directoryTeamId === 'string'
          ? key.directoryTeamId
          : ''
        const teamId = directoryTeamId.split('#team#')[1] ?? ''
        const issueId = typeof key.issueId === 'string' ? key.issueId : ''
        return { Item: issues.get(`${teamId}\0${issueId}`) }
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

  const result = await client.updateTeamIssueSchedules(
    'workspace-1',
    updates,
    [],
    'demo@example.com',
    undefined,
    [],
    undefined,
    {
      async prepare(response) {
        preparedResponse = response
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', state: 'completed' },
            },
          },
        }
      },
    },
  )

  const serializedReceipt = JSON.stringify(preparedResponse)
  expect(result.issues).toHaveLength(24)
  expect(result.issues.every((issue) => issue.description === largeText)).toBeTrue()
  expect(Buffer.byteLength(serializedReceipt, 'utf8')).toBeLessThanOrEqual(256 * 1024)
  expect(serializedReceipt).not.toContain('description')
  expect(serializedReceipt).not.toContain(largeText)
})

test('DynamoDB Work Item schedule cascade classifies cancellation indexes by safe priority', async () => {
  await withTestEnvironment({
    MUKUROJI_WORKSPACE_ACCESS_TABLE: 'WorkspaceAccessTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
    ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable',
  }, async () => {
    const issues = new Map([
      ['core-team\0root', createScheduleCascadeIssue('core-team', 'root')],
      ['other-team\0successor', createScheduleCascadeIssue('other-team', 'successor')],
    ])
    const relationChecks: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
      ConditionCheck: {
        TableName: 'ConfigurationTable',
        Key: { workspaceId: 'workspace-1', recordKey: 'RELATION#core-team' },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': 4 },
      },
    }]

    /**
     * Runs one cascade whose transaction cancellation is selected by semantic item labels.
     *
     * @param failedLabels - Transaction item kinds that report conditional failure.
     * @param reasonMode - Whether cancellation reasons are indexed, missing, empty, or unknown.
     * @returns Rejected cascade mutation.
     */
    const runCascade = (
      failedLabels: readonly string[],
      reasonMode: 'indexed' | 'missing' | 'empty' | 'unknown' = 'indexed',
    ) => {
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'GetCommand') {
            const key = isUnknownRecord(command.input.Key) ? command.input.Key : {}
            const directoryTeamId = typeof key.directoryTeamId === 'string'
              ? key.directoryTeamId
              : ''
            const teamId = directoryTeamId.split('#team#')[1] ?? ''
            const issueId = typeof key.issueId === 'string' ? key.issueId : ''
            return { Item: issues.get(`${teamId}\0${issueId}`) }
          }
          if (command.constructor.name === 'TransactWriteCommand') {
            const transactItems = Array.isArray(command.input.TransactItems)
              ? command.input.TransactItems
              : []
            const labels = transactItems.map((item) => {
              if (!isUnknownRecord(item)) return 'unknown'
              if (isUnknownRecord(item.Update)) return 'update'
              if (isUnknownRecord(item.Put)) return 'event'
              if (!isUnknownRecord(item.ConditionCheck)) return 'unknown'
              const tableName = item.ConditionCheck.TableName
              if (tableName === 'IssuesTable') return 'guard'
              if (tableName === 'ConfigurationTable') return 'relation'
              if (tableName === 'WorkspaceAccessTable') return 'workspace-member'
              if (tableName === 'PlanningTable') return 'planning'
              if (tableName === 'EnterpriseIdentityTable') return 'enterprise-control'
              return 'unknown'
            })
            const error = Object.assign(new Error('Transaction was canceled.'), {
              name: 'TransactionCanceledException',
              $metadata: { httpStatusCode: 400 },
            })
            if (reasonMode === 'indexed') {
              Object.assign(error, {
                CancellationReasons: labels.map((label) => ({
                  Code: failedLabels.includes(label) ? 'ConditionalCheckFailed' : 'None',
                })),
              })
            } else if (reasonMode === 'empty') {
              Object.assign(error, { CancellationReasons: [] })
            } else if (reasonMode === 'unknown') {
              Object.assign(error, { CancellationReasons: [{ Code: 'TransactionConflict' }] })
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
      return client.updateTeamIssueSchedules(
        'workspace-1',
        [
          {
            teamId: 'core-team',
            workItemId: 'root',
            expectedRevision: 1,
            schedule: createDueDateSchedule('2026-07-21'),
          },
          {
            teamId: 'other-team',
            workItemId: 'successor',
            expectedRevision: 1,
            schedule: createDueDateSchedule('2026-07-22'),
          },
        ],
        [{ teamId: 'guard-team', workItemId: 'fan-in', expectedRevision: 7 }],
        'demo@example.com',
        undefined,
        relationChecks,
        {
          workspaceId: 'workspace-1',
          memberKey: 'demo@example.com',
          workspaceMemberVersion: 3,
          planningRevision: 8,
          enterpriseControlRevision: 5,
        },
      )
    }

    for (const scenario of [
      {
        failedLabels: ['update', 'workspace-member'],
        expectedCode: 'WorkItemAuthorizationChanged',
      },
      {
        failedLabels: ['planning', 'enterprise-control'],
        expectedCode: 'WorkItemAuthorizationChanged',
      },
      {
        failedLabels: ['update', 'relation', 'planning'],
        expectedCode: 'PlanningRevisionConflict',
      },
      {
        failedLabels: ['update', 'relation'],
        expectedCode: 'WorkItemRevisionConflict',
      },
      {
        failedLabels: ['relation'],
        expectedCode: 'WorkItemRelationGraphConflict',
      },
      {
        failedLabels: ['event'],
        expectedCode: 'WorkItemScheduleCascadeConflict',
      },
    ]) {
      await expect(runCascade(scenario.failedLabels)).rejects.toMatchObject({
        code: scenario.expectedCode,
        status: 409,
      })
    }

    for (const reasonMode of ['missing', 'empty', 'unknown'] as const) {
      await expect(runCascade([], reasonMode)).rejects.toMatchObject({
        code: 'WorkItemScheduleCascadeTransactionUnavailable',
        status: 503,
      })
    }
  })
})

test('DynamoDB Work Item update emits render-ready notification candidates', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-07-20',
    schedule: createDueDateSchedule('2026-07-20'),
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
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    dueDate: '2026-06-03',
    schedule: createDueDateSchedule('2026-06-03'),
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
