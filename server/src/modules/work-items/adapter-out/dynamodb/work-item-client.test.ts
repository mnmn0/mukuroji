import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  resetTestApp,
  withTestEnvironment,
} = createApiTestHarness()
import { DynamoDbTeamIssuesClient } from './work-item-client'
import {
  createMutationAuditContext,
} from '../../../audit/audit'
import { ProjectDataError } from '../../../directory'
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
  createSearchWorkItemTypeKey,
  type DueDateWorkItemSchedule,
  type TriageEntry,
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

/** Creates a full-visibility Triage source containing secrets that must not cross the merge. */
function createDuplicateContextEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    schemaVersion: 1,
    id: 'triage-context-1',
    workspaceId: 'workspace-1',
    source: {
      kind: 'email',
      sourceId: 'provider-secret-source-id',
      provider: 'provider-secret-name',
      containerId: 'provider-secret-mailbox',
      messageId: 'provider-secret-message',
    },
    sourcePreview: {
      title: 'Sensitive customer subject',
      body: 'Sensitive customer body that must not be copied.',
      channelLabel: 'Restricted support mailbox',
      permalink: 'https://provider.example/private/message',
      attachmentCount: 2,
      commentCount: 3,
      watcherCount: 4,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: 'Private Requester',
      email: 'private-requester@example.com',
      externalId: 'provider-secret-requester',
      guest: true,
    },
    receivedAt: '2026-08-08T00:00:00.000Z',
    lastActivityAt: '2026-08-08T01:00:00.000Z',
    state: 'pending',
    routing: { reason: 'Private routing reason', candidates: [] },
    teamId: 'core',
    permission: {
      visibility: 'full',
      canReply: true,
      guestVisible: false,
      checkedAt: '2026-08-08T01:00:00.000Z',
    },
    retention: { expiresAt: '2026-09-08T00:00:00.000Z' },
    capabilities: {
      canAssign: true,
      canAcceptCreate: true,
      canAcceptLink: true,
      canMarkDuplicate: true,
      canDecline: true,
      canSnooze: true,
      canRequestInformation: true,
      canReply: true,
      canViewInternalContext: true,
    },
    events: [{
      id: 'triage-created-context-1',
      type: 'created',
      actorId: 'provider-secret-actor',
      summary: 'A provider-secret-free source event summary.',
      createdAt: '2026-08-08T00:00:00.000Z',
    }],
    revision: 2,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T01:00:00.000Z',
    ...overrides,
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

test('DynamoDB Work Item list clients stop pagination at the requested read limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
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
        Items: [canonicalWorkItem],
        LastEvaluatedKey: { more: true },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 1 })
  await workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 1 })

  expect(sentInputs).toHaveLength(2)
  expect(sentInputs.map((input) => input.Limit)).toEqual([1, 1])
})

test('DynamoDB local bootstrap adds missing Team Issue event indexes in stages', async () => {
  await withTestEnvironment({ DYNAMODB_ENDPOINT: 'http://localhost:8000' }, async () => {
    const eventIndexes = new Set<string>()
    let updateCalls = 0
    const dynamoDbClient = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        if (command.constructor.name === 'CreateTableCommand') {
          throw Object.assign(new Error('Table already exists.'), {
            name: 'ResourceInUseException',
          })
        }
        if (command.constructor.name === 'UpdateTableCommand') {
          updateCalls += 1
          eventIndexes.add(
            updateCalls === 1
              ? 'TeamIssueEventCreatedAtIndex'
              : 'TeamIssueCommentCreatedAtIndex',
          )
          return {}
        }
        if (command.constructor.name !== 'DescribeTableCommand') {
          throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`)
        }

        if (command.input.TableName === 'WorkItemsTable') {
          return {
            Table: {
              TableStatus: 'ACTIVE',
              KeySchema: [
                { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
                { AttributeName: 'issueId', KeyType: 'RANGE' },
              ],
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'TeamIssueSortOrderIndex',
                  KeySchema: [
                    { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
                    { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                  ],
                },
                {
                  IndexName: 'AssignedProjectIssueIndex',
                  KeySchema: [
                    { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
                    { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                  ],
                },
                {
                  IndexName: 'TeamIssueUpdatedAtIndex',
                  KeySchema: [
                    { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
                    { AttributeName: 'updatedAt', KeyType: 'RANGE' },
                  ],
                },
              ],
            },
          }
        }

        return {
          Table: {
            TableStatus: 'ACTIVE',
            KeySchema: [
              { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
              { AttributeName: 'eventId', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [...eventIndexes].map((indexName) => ({
              IndexName: indexName,
              KeySchema: [
                { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
                {
                  AttributeName: indexName === 'TeamIssueEventCreatedAtIndex'
                    ? 'createdAt'
                    : 'commentCreatedAtOrder',
                  KeyType: 'RANGE',
                },
              ],
            })),
          },
        }
      },
    } as unknown as DynamoDBClient
    const documentClient = {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetCommand') {
          return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
        }
        return { Items: [] }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'WorkItemsTable',
      'IssueEventsTable',
      documentClient,
      dynamoDbClient,
      true,
      '',
    )

    await expect(client.getTeamIssueDetail(
      'workspace-1',
      'core',
      'canonical-work-item',
      { eventLimit: 0 },
    )).resolves.toMatchObject({ comments: [] })
    expect(updateCalls).toBe(2)
  })
})

test('DynamoDB Work Item list clients skip DynamoDB reads when limit is zero', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

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

/** Verifies that pre-cutover Automation replay reads use the exact event key and strong consistency. */
test('DynamoDB Team Work Item client reads a matching pre-cutover Automation comment replay', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Item: {
          directoryId: 'workspace-1',
          directoryTeamId: 'workspace-1#team#core-team',
          directoryTeamIssueId: 'workspace-1#team#core-team#issue#onboarding-friction',
          teamId: 'core-team',
          issueId: 'onboarding-friction',
          eventId: 'automation-execution-1_comment_0',
          eventType: 'commented',
          actorUserId: 'automation:rule-1',
          body: 'Pre-cutover comment',
          summary: 'Comment was added.',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
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

  await expect(client.getAutomationCommentReplay(
    'workspace-1',
    'core-team',
    'onboarding-friction',
    'automation-execution-1_comment_0',
    'automation:rule-1',
    'Pre-cutover comment',
  )).resolves.toBe(true)
  expect(sentInputs).toEqual([{
    TableName: 'IssueEventsTable',
    Key: {
      directoryTeamIssueId: 'workspace-1#team#core-team#issue#onboarding-friction',
      eventId: 'automation-execution-1_comment_0',
    },
    ConsistentRead: true,
  }])
})

test('DynamoDB Team Work Item detail rejects a commented event without a body', async () => {
  const canonicalWorkItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
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
      if (command.input.TableName === 'WorkItemsTable') {
        return { Item: canonicalWorkItem }
      }
      return {
        Items: [{
          directoryId: 'workspace-1',
          directoryTeamIssueId: 'workspace-1#team#core-team#issue#onboarding-friction',
          teamId: 'core-team',
          issueId: 'onboarding-friction',
          eventId: 'malformed-comment',
          eventType: 'commented',
          actorUserId: 'sato@example.com',
          summary: 'Malformed comment',
          createdAt: '2026-07-12T01:00:00.000Z',
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core-team',
    'onboarding-friction',
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
})

test('DynamoDB Team Work Item detail rejects a malformed body on non-comment events', async () => {
  const canonicalWorkItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
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
      if (command.input.TableName === 'WorkItemsTable') {
        return { Item: canonicalWorkItem }
      }
      return {
        Items: [{
          directoryId: 'workspace-1',
          directoryTeamIssueId: 'workspace-1#team#core-team#issue#onboarding-friction',
          teamId: 'core-team',
          issueId: 'onboarding-friction',
          eventId: 'malformed-created-event',
          eventType: 'created',
          actorUserId: 'sato@example.com',
          body: { unexpected: 'object' },
          summary: 'Malformed created event',
          createdAt: '2026-07-12T01:00:00.000Z',
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core-team',
    'onboarding-friction',
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
})

test('DynamoDB Team Work Item detail falls back when the comment index is stale', async () => {
  const partitionKey = 'workspace-1#team#core#issue#canonical-work-item'
  const queryInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      if (command.constructor.name !== 'QueryCommand') {
        return {}
      }

      queryInputs.push(command.input)
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        return { Items: [] }
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        return {
          Items: [],
        }
      }

      if (command.input.ProjectionExpression !== undefined) {
        return {
          Items: [{
            eventId: 'comment-event',
            eventType: 'commented',
            createdAt: '2026-07-12T00:00:00.000Z',
          }],
        }
      }

      return {
        Items: [{
          directoryId: 'workspace-1',
          directoryTeamIssueId: partitionKey,
          teamId: 'core',
          issueId: 'canonical-work-item',
          eventId: 'comment-event',
          eventType: 'commented',
          actorUserId: 'sato@example.com',
          body: 'Older comment',
          summary: 'Commented',
          createdAt: '2026-07-12T00:00:00.000Z',
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).resolves.toMatchObject({
    comments: [{ id: 'comment-event', body: 'Older comment' }],
  })
  expect(queryInputs).toHaveLength(4)
  expect(queryInputs.some((input) =>
    input.IndexName === 'TeamIssueEventCreatedAtIndex' && input.Limit === 500,
  )).toBe(true)
  expect(queryInputs.some((input) =>
    input.IndexName === undefined &&
    input.ProjectionExpression !== undefined &&
    input.ConsistentRead === true,
  )).toBe(true)
  expect(queryInputs.some((input) =>
    input.IndexName === undefined &&
    input.ConsistentRead === true &&
    input.ProjectionExpression === undefined,
  )).toBe(true)
})

test('DynamoDB Team Work Item legacy comment fallback stops at its read budget', async () => {
  const queryInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      queryInputs.push(command.input)
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        throw Object.assign(new Error('Comment index is not active yet.'), {
          name: 'ResourceNotFoundException',
        })
      }
      return {
        Items: [{
          directoryId: 'workspace-1',
          directoryTeamIssueId: 'workspace-1#team#core#issue#canonical-work-item',
          teamId: 'core',
          issueId: 'canonical-work-item',
          eventId: 'comment-event',
          eventType: 'commented',
          actorUserId: 'sato@example.com',
          body: 'Older comment',
          summary: 'Commented',
          createdAt: '2026-07-12T00:00:00.000Z',
          commentCreatedAtOrder: '2026-07-12T00:00:00.000Z#comment-event',
        }],
        LastEvaluatedKey: { more: true },
        ScannedCount: 500,
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
  expect(queryInputs).toEqual([
    expect.objectContaining({ IndexName: 'TeamIssueCommentCreatedAtIndex' }),
    expect.objectContaining({
      IndexName: 'TeamIssueEventCreatedAtIndex',
      Limit: 500,
    }),
  ])
})

test('DynamoDB Team Work Item legacy comment fallback shares one read budget across validation stages', async () => {
  const queryInputs: Array<Record<string, unknown>> = []
  let scannedRows = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      queryInputs.push(command.input)
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        throw Object.assign(new Error('Comment index is not active yet.'), {
          name: 'ResourceNotFoundException',
        })
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        scannedRows += 250
        return {
          Items: [{
            directoryId: 'workspace-1',
            directoryTeamIssueId: 'workspace-1#team#core#issue#canonical-work-item',
            teamId: 'core',
            issueId: 'canonical-work-item',
            eventId: 'indexed-comment-event',
            eventType: 'commented',
            actorUserId: 'sato@example.com',
            body: 'Indexed comment',
            summary: 'Commented',
            createdAt: '2026-07-12T00:00:00.000Z',
            commentCreatedAtOrder: '2026-07-12T00:00:00.000Z#indexed-comment-event',
          }],
          ScannedCount: 250,
        }
      }
      if (command.input.ProjectionExpression !== undefined) {
        scannedRows += 249
        return {
          Items: [{
            createdAt: '2026-07-12T00:00:00.000Z',
            eventId: 'coverage-comment-event',
            eventType: 'commented',
          }],
          ScannedCount: 249,
        }
      }
      scannedRows += 1
      return {
        Items: [{
          directoryId: 'workspace-1',
          directoryTeamIssueId: 'workspace-1#team#core#issue#canonical-work-item',
          teamId: 'core',
          issueId: 'canonical-work-item',
          eventId: 'base-comment-event',
          eventType: 'commented',
          actorUserId: 'sato@example.com',
          body: 'Base comment',
          summary: 'Commented',
          createdAt: '2026-07-12T00:00:00.000Z',
          commentCreatedAtOrder: '2026-07-12T00:00:00.000Z#base-comment-event',
        }],
        ScannedCount: 1,
        LastEvaluatedKey: { more: true },
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
  expect(scannedRows).toBe(500)
  expect(queryInputs).toHaveLength(4)
  expect(queryInputs[0]?.IndexName).toBe('TeamIssueCommentCreatedAtIndex')
  expect(queryInputs[1]).toMatchObject({
    IndexName: 'TeamIssueEventCreatedAtIndex',
    Limit: 500,
  })
  expect(queryInputs[2]).toMatchObject({
    Limit: 250,
    ProjectionExpression: expect.any(String),
  })
  expect(queryInputs[2]?.IndexName).toBeUndefined()
  expect(queryInputs[3]).toMatchObject({ Limit: 1 })
  expect(queryInputs[3]?.IndexName).toBeUndefined()
  expect(queryInputs[3]?.ProjectionExpression).toBeUndefined()
})

test('DynamoDB Team Work Item comment preview orders offset timestamps by instant', async () => {
  const partitionKey = 'workspace-1#team#core#issue#canonical-work-item'
  const queryInputs: Array<Record<string, unknown>> = []
  const comments = [
    {
      directoryId: 'workspace-1',
      directoryTeamIssueId: partitionKey,
      teamId: 'core',
      issueId: 'canonical-work-item',
      eventId: 'older-comment',
      eventType: 'commented',
      actorUserId: 'sato@example.com',
      body: 'Older comment',
      summary: 'Commented',
      createdAt: '2026-07-16T09:00:00+09:00',
      commentCreatedAtOrder: '2026-07-16T00:00:00.000Z#older-comment',
    },
    {
      directoryId: 'workspace-1',
      directoryTeamIssueId: partitionKey,
      teamId: 'core',
      issueId: 'canonical-work-item',
      eventId: 'newer-comment',
      eventType: 'commented',
      actorUserId: 'sato@example.com',
      body: 'Newer comment',
      summary: 'Commented',
      createdAt: '2026-07-16T01:00:00.000Z',
      commentCreatedAtOrder: '2026-07-16T01:00:00.000Z#newer-comment',
    },
  ]
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      queryInputs.push(command.input)
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        return { Items: [comments[1], comments[0]] }
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        return { Items: comments }
      }
      return {
        Items: comments.map(({ eventId, eventType, createdAt }) => ({
          eventId,
          eventType,
          createdAt,
        })),
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).resolves.toMatchObject({
    comments: [{ id: 'newer-comment', body: 'Newer comment' }],
  })
  expect(queryInputs.some((input) =>
    input.IndexName === 'TeamIssueCommentCreatedAtIndex' &&
    input.ScanIndexForward === false &&
    input.Limit === 1,
  )).toBe(true)
})

test('DynamoDB Team Work Item comment preview falls back while the comment index is deploying', async () => {
  const partitionKey = 'workspace-1#team#core#issue#canonical-work-item'
  const queryInputs: Array<Record<string, unknown>> = []
  const comments = [
    {
      directoryId: 'workspace-1',
      directoryTeamIssueId: partitionKey,
      teamId: 'core',
      issueId: 'canonical-work-item',
      eventId: 'older-comment',
      eventType: 'commented',
      actorUserId: 'sato@example.com',
      body: 'Older comment',
      summary: 'Commented',
      createdAt: '2026-07-16T09:00:00+09:00',
      commentCreatedAtOrder: '2026-07-16T00:00:00.000Z#older-comment',
    },
    {
      directoryId: 'workspace-1',
      directoryTeamIssueId: partitionKey,
      teamId: 'core',
      issueId: 'canonical-work-item',
      eventId: 'newer-comment',
      eventType: 'commented',
      actorUserId: 'sato@example.com',
      body: 'Newer comment',
      summary: 'Commented',
      createdAt: '2026-07-16T01:00:00.000Z',
      commentCreatedAtOrder: '2026-07-16T01:00:00.000Z#newer-comment',
    },
  ]
  const commentCoverage = comments.map(({ eventId, eventType, createdAt }) => ({
    eventId,
    eventType,
    createdAt,
  }))
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      queryInputs.push(command.input)
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        throw Object.assign(new Error('Comment index is not active yet.'), {
          name: 'ResourceNotFoundException',
        })
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        return { Items: comments }
      }
      if (command.input.ProjectionExpression !== undefined) {
        return { Items: commentCoverage }
      }
      return { Items: comments }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).resolves.toMatchObject({
    comments: [{ id: 'newer-comment', body: 'Newer comment' }],
  })
  expect(queryInputs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      IndexName: 'TeamIssueCommentCreatedAtIndex',
    }),
    expect.objectContaining({
      IndexName: 'TeamIssueEventCreatedAtIndex',
      ScanIndexForward: false,
    }),
    expect.objectContaining({
      ProjectionExpression: expect.any(String),
      ConsistentRead: true,
    }),
  ]))
  expect(queryInputs.some((input) =>
    input.IndexName === 'TeamIssueEventCreatedAtIndex' && input.Limit === 500,
  )).toBe(true)
})

test('DynamoDB Team Work Item bounded legacy comments fail closed on invalid coverage rows', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        throw Object.assign(new Error('Comment index is not active yet.'), {
          name: 'ResourceNotFoundException',
        })
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        return {
          Items: [{
            eventId: 'valid-comment',
            eventType: 'commented',
            createdAt: '2026-07-12T00:00:00.000Z',
          }],
        }
      }
      return {
        Items: [{
          eventId: 'malformed-comment',
          eventType: 'commented',
          createdAt: 'not-a-timestamp',
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    {
      eventLimit: 1,
      eventType: 'commented',
      newestEventsFirst: true,
    },
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
})

test('DynamoDB Team Work Item detail rejects a comment omitted from the sparse index', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      if (command.input.IndexName === 'TeamIssueCommentCreatedAtIndex') {
        return { Items: [] }
      }
      if (command.input.IndexName === 'TeamIssueEventCreatedAtIndex') {
        return { Items: [] }
      }
      return {
        Items: [{
          eventId: 'malformed-comment',
          eventType: 'commented',
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
    { eventType: 'commented' },
  )).rejects.toMatchObject({
    status: 503,
    code: 'InvalidTeamIssue',
  })
})

/** Verifies that pre-cutover replay transport failures use the Work Item error contract. */
test('DynamoDB Team Work Item client classifies pre-cutover replay transport failures', async () => {
  const documentClient = {
    async send() {
      throw Object.assign(new Error('DynamoDB throttled'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      })
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.getAutomationCommentReplay(
    'workspace-1',
    'core-team',
    'onboarding-friction',
    'automation-execution-1_comment_0',
    'automation:rule-1',
    'Pre-cutover comment',
  )).rejects.toMatchObject({
    status: 429,
    code: 'ThrottlingException',
  })
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

test('DynamoDB Project Work Item type filters remain qualified by Team', async () => {
  const baseWorkItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryProjectId: 'user#demo@example.com#project#refero',
    assignedProjectId: 'refero',
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
    workItemTypeId: 'bug',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send() {
      return {
        Items: [
          {
            ...baseWorkItem,
            directoryTeamId: 'user#demo@example.com#team#team-a',
            issueId: 'team-a-bug',
            teamId: 'team-a',
          },
          {
            ...baseWorkItem,
            directoryTeamId: 'user#demo@example.com#team#team-b',
            issueId: 'team-b-bug',
            teamId: 'team-b',
          },
        ],
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

  const response = await client.getProjectIssues('user#demo@example.com', 'refero', {
    workItemTypeId: createSearchWorkItemTypeKey('team-a', 'bug'),
  })

  expect(response.issues.map((issue) => issue.id)).toEqual(['team-a-bug'])
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

test('DynamoDB Work Item creation persists a Customer preparation marker for completed items', async () => {
  let workItemTransaction: Record<string, unknown> | undefined
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (command.constructor.name === 'TransactWriteCommand') {
        workItemTransaction = command.input
      }
      return command.constructor.name === 'QueryCommand' ? { Items: [] } : {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await client.createTeamIssue(
    'workspace-1',
    'core-team',
    {
      title: 'Already completed',
      assigneeUserId: 'demo@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
      customFieldValues: {},
      schedule: createDueDateSchedule('2026-07-20'),
      priority: 'medium',
    },
    'demo@example.com',
  )

  const item = workItemTransaction
    ? readTransactionPutItem(workItemTransaction, 'WorkItemsTable')
    : undefined
  expect(item).toMatchObject({
    statusCategory: 'completed',
    customerCompletionPreparationAt: expect.any(String),
    customerCompletionPreparationRevision: 1,
  })
})

test('duplicate Triage context is atomically guarded and de-identified on the Work Item', () => {
  const client = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = client.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 7,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry(),
    mergedAt: '2026-08-09T00:00:00.000Z',
  })

  expect(contribution.snapshot).toEqual({
    triageEntryId: 'triage-context-1',
    sourceKind: 'email',
    visibilityAtMerge: 'full',
    availability: 'summary-metadata',
    receivedAt: '2026-08-08T00:00:00.000Z',
    lastActivityAt: '2026-08-08T01:00:00.000Z',
    sourceRetentionExpiresAt: '2026-09-08T00:00:00.000Z',
    commentMetadataCount: 3,
    attachmentMetadataCount: 2,
    watcherMetadataCount: 4,
    events: [{
      eventId: 'triage-created-context-1',
      type: 'created',
      summary: 'Triage entry was created.',
      createdAt: '2026-08-08T00:00:00.000Z',
    }],
    mergedAt: '2026-08-09T00:00:00.000Z',
  })
  expect(contribution.transactItems).toEqual([
    {
      ConditionCheck: {
        TableName: 'WorkItemsTable',
        Key: {
          directoryTeamId: 'workspace-1#team#core',
          issueId: 'canonical-work-item',
        },
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': 7 },
      },
    },
    {
      Put: expect.objectContaining({
        TableName: 'IssueEventsTable',
        ConditionExpression:
          'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
        Item: expect.objectContaining({
          eventType: 'triage-context-merged',
          triageContextSnapshot: contribution.snapshot,
        }),
      }),
    },
  ])
  const persistedProjection = JSON.stringify(contribution.transactItems)
  for (const secret of [
    'Sensitive customer subject',
    'Sensitive customer body that must not be copied.',
    'private-requester@example.com',
    'provider-secret-source-id',
    'provider-secret-message',
    'provider-secret-actor',
    'https://provider.example/private/message',
  ]) {
    expect(persistedProjection).not.toContain(secret)
  }
})

test('duplicate Triage context replaces every lifecycle summary with a fixed allowlisted value', () => {
  const client = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = client.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 7,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry({
      events: [
        {
          id: 'declined-secret',
          type: 'declined',
          actorId: 'operator-secret',
          summary: 'Declined because provider-secret-customer-content was exposed.',
          createdAt: '2026-08-08T02:00:00.000Z',
        },
        {
          id: 'activity-secret',
          type: 'activity-received',
          actorId: 'provider-secret-actor',
          summary: 'Provider payload contained customer-secret-message.',
          createdAt: '2026-08-08T03:00:00.000Z',
        },
      ],
    }),
    mergedAt: '2026-08-09T00:00:00.000Z',
  })

  expect(contribution.snapshot.events).toEqual([
    {
      eventId: 'declined-secret',
      type: 'declined',
      summary: 'Triage entry was declined.',
      createdAt: '2026-08-08T02:00:00.000Z',
    },
    {
      eventId: 'activity-secret',
      type: 'activity-received',
      summary: 'New source activity was received.',
      createdAt: '2026-08-08T03:00:00.000Z',
    },
  ])
  const persistedProjection = JSON.stringify(contribution.transactItems)
  expect(persistedProjection).not.toContain('provider-secret-customer-content')
  expect(persistedProjection).not.toContain('customer-secret-message')
})

test('duplicate context retains only redaction provenance after source retention expires', () => {
  const client = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = client.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 7,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry({
      permission: {
        visibility: 'metadata-only',
        canReply: false,
        guestVisible: false,
        reasonCode: 'retention-expired',
        checkedAt: '2026-08-09T00:00:00.000Z',
      },
      retention: {
        expiresAt: '2026-08-09T00:00:00.000Z',
        redactedAt: '2026-08-09T00:00:00.000Z',
      },
    }),
    mergedAt: '2026-08-09T00:00:01.000Z',
  })

  expect(contribution.snapshot).toMatchObject({
    availability: 'redacted',
    visibilityAtMerge: 'metadata-only',
    sourceRedactedAt: '2026-08-09T00:00:00.000Z',
    commentMetadataCount: 0,
    attachmentMetadataCount: 0,
    watcherMetadataCount: 0,
    events: [],
  })
})

test('duplicate context treats an elapsed retention deadline as redacted', () => {
  const client = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = client.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 7,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry({
      retention: {
        expiresAt: '2026-08-09T00:00:00.000Z',
      },
    }),
    mergedAt: '2026-08-09T00:00:01.000Z',
  })

  expect(contribution.snapshot).toMatchObject({
    availability: 'redacted',
    commentMetadataCount: 0,
    attachmentMetadataCount: 0,
    watcherMetadataCount: 0,
    events: [],
  })
})

test('metadata-only duplicate context excludes internal lifecycle summaries', () => {
  const client = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = client.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 7,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry({
      permission: {
        visibility: 'metadata-only',
        canReply: false,
        guestVisible: false,
        reasonCode: 'provider-metadata-only',
        checkedAt: '2026-08-09T00:00:00.000Z',
      },
    }),
    mergedAt: '2026-08-09T00:00:01.000Z',
  })

  expect(contribution.snapshot).toMatchObject({
    availability: 'counts-only',
    visibilityAtMerge: 'metadata-only',
    commentMetadataCount: 3,
    attachmentMetadataCount: 2,
    watcherMetadataCount: 4,
    events: [],
  })
  expect(JSON.stringify(contribution.transactItems))
    .not.toContain('Triage entry was created.')
})

test('Work Item detail re-reads retained duplicate context without the source row', async () => {
  const preparingClient = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = preparingClient.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 1,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry(),
    mergedAt: '2026-08-09T00:00:00.000Z',
  })
  const eventItem = contribution.transactItems[1]?.Put?.Item
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      if (command.constructor.name === 'QueryCommand') {
        return { Items: eventItem ? [eventItem] : [] }
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

  const detail = await client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
  )

  expect(detail.triageContextSnapshots).toEqual([contribution.snapshot])
  expect(detail.activity).toEqual([
    expect.objectContaining({ type: 'triage-context-merged' }),
  ])
})

test('Work Item detail rejects unknown duplicate-context fields instead of leaking them', async () => {
  const preparingClient = new DynamoDbTeamIssuesClient('WorkItemsTable', 'IssueEventsTable')
  const contribution = preparingClient.createTriageDuplicateContextTransactionItems({
    directoryId: 'workspace-1',
    teamId: 'core',
    workItemId: 'canonical-work-item',
    expectedWorkItemRevision: 1,
    actorUserId: 'triager@example.com',
    entry: createDuplicateContextEntry(),
    mergedAt: '2026-08-09T00:00:00.000Z',
  })
  const eventItem = contribution.transactItems[1]?.Put?.Item
  if (!eventItem || !isUnknownRecord(eventItem.triageContextSnapshot)) {
    throw new TypeError('Expected a duplicate-context event fixture.')
  }
  const contaminatedEvent = {
    ...eventItem,
    triageContextSnapshot: {
      ...eventItem.triageContextSnapshot,
      requesterEmail: 'must-not-leak@example.com',
    },
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        return { Item: createScheduleCascadeIssue('core', 'canonical-work-item') }
      }
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [contaminatedEvent] }
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

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core',
    'canonical-work-item',
  )).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
})

test('DynamoDB Work Item creation commits a deterministic Triage acceptance contribution', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  let persistedItem: Record<string, unknown> | undefined
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'QueryCommand') {
        return { Items: persistedItem ? [persistedItem] : [] }
      }
      if (command.constructor.name === 'GetCommand') {
        return { Item: persistedItem }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const nextItem = readTransactionPutItem(command.input, 'WorkItemsTable')
        if (!persistedItem) {
          if (!nextItem) throw new Error('Work Item transaction Put was not captured.')
          persistedItem = nextItem
          return {}
        }
        const transactItems = command.input.TransactItems
        const error = new Error('The deterministic Work Item already exists.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: Array.isArray(transactItems)
            ? transactItems.map((_, index) => ({
                Code: index === 0 ? 'ConditionalCheckFailed' : 'None',
              }))
            : [],
        })
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
  const entryId = 'triage_20260809_acceptance'
  const contribution = {
    ConditionCheck: {
      TableName: 'RequestIntakeTable',
      Key: { scopeKey: 'WORKSPACE#workspace-1', recordKey: `TRIAGE#${entryId}` },
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    },
  }

  const response = await client.createTeamIssue(
    'workspace-1',
    'core-team',
    {
      title: 'Accepted Triage request',
      assigneeUserId: 'demo@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: createDueDateSchedule('2026-08-14'),
      priority: 'high',
      idempotentIssueId: `triage-${'a'.repeat(48)}`,
      idempotentRequestDigest: 'b'.repeat(64),
    },
    'demo@example.com',
    undefined,
    undefined,
    {
      entryId,
      occurredAt: '2026-08-09T00:00:00.000Z',
      transactItems: [contribution],
    },
  )
  const replay = await client.createTeamIssue(
    'workspace-1',
    'core-team',
    {
      title: 'Accepted Triage request',
      assigneeUserId: 'demo@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: createDueDateSchedule('2026-08-14'),
      priority: 'high',
      idempotentIssueId: `triage-${'a'.repeat(48)}`,
      idempotentRequestDigest: 'b'.repeat(64),
    },
    'demo@example.com',
    undefined,
    undefined,
    {
      entryId,
      occurredAt: '2026-08-09T00:00:00.000Z',
      transactItems: [contribution],
    },
  )

  expect(response.issue).toMatchObject({
    id: `triage-${'a'.repeat(48)}`,
    sourceTriageEntryId: entryId,
  })
  expect(replay).toEqual(response)
  const transaction = sentCommands.find((command) =>
    command.name === 'TransactWriteCommand'
  )
  const transactionItems = (transaction?.input as TransactWriteCommandInput | undefined)
    ?.TransactItems
  expect(transactionItems?.[0]).toMatchObject({
    Put: {
      Item: {
        importRequestDigest: 'b'.repeat(64),
        sourceTriageEntryId: entryId,
      },
    },
  })
  expect(transactionItems?.at(-1)).toEqual(contribution)
  expect(sentCommands.filter((command) =>
    command.name === 'TransactWriteCommand'
  )).toHaveLength(2)
  expect(sentCommands.filter((command) =>
    command.name === 'GetCommand'
  )).toHaveLength(1)
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
            dueDateUpdatedAt:
              updateValues[':dueDateUpdatedAt'] ?? persistedItem.dueDateUpdatedAt,
            priority: updateValues[':priority'] ?? persistedItem.priority,
            priorityUpdatedAt:
              updateValues[':priorityUpdatedAt'] ?? persistedItem.priorityUpdatedAt,
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
  expect(created.issue.priorityUpdatedAt).toBe(created.issue.createdAt)
  expect(created.issue.dueDateUpdatedAt).toBe(created.issue.createdAt)
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
  expect(updated.issue.dueDateUpdatedAt).toBe(updated.issue.updatedAt)
  expect(updated.issue.priorityUpdatedAt).toBe(created.issue.priorityUpdatedAt)
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
  expect(deadlineUpdated.issue.dueDateUpdatedAt).toBe(deadlineUpdated.issue.updatedAt)
  expect(deadlineUpdated.issue.priorityUpdatedAt).toBe(created.issue.priorityUpdatedAt)

  const priorityUpdated = await client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    created.issue.id,
    {
      expectedRevision: 3,
      priority: 'medium',
    },
    'demo@example.com',
  )

  expect(priorityUpdated.issue.priority).toBe('medium')
  expect(priorityUpdated.issue.priorityUpdatedAt).toBe(priorityUpdated.issue.updatedAt)
  expect(priorityUpdated.issue.dueDateUpdatedAt).toBe(deadlineUpdated.issue.dueDateUpdatedAt)
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
        ':customerCompletionPreparationRevision': 2,
        ':customerCompletionPreparationAt': expect.any(String),
      },
      ExpressionAttributeNames: expect.objectContaining({
        '#customerCompletionPreparationAt': 'customerCompletionPreparationAt',
        '#customerCompletionPreparationRevision': 'customerCompletionPreparationRevision',
      }),
      UpdateExpression: expect.stringContaining(
        '#customerCompletionPreparationRevision = :customerCompletionPreparationRevision',
      ),
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

test('DynamoDB Work Item clears the Customer completion marker when leaving completion', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    ...createScheduleCascadeIssue('core-team', 'reopened'),
    revision: 3,
    workflowStatusId: 'done',
    statusCategory: 'completed',
    customerCompletionPreparationAt: '2026-07-20T00:00:00.000Z',
    customerCompletionPreparationRevision: 3,
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'reopen-customer-notifications',
    occurredAt: '2026-07-20T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/reopened' },
    source: { kind: 'api', requestId: 'reopen-customer-notifications' },
  })
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
    'AuditTable',
  )

  const updated = await client.updateTeamIssue(
    'workspace-1',
    'core-team',
    'reopened',
    {
      expectedRevision: 3,
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'started',
    },
    'demo@example.com',
    auditContext,
  )

  expect(updated.issue).toMatchObject({
    revision: 4,
    workflowStatusId: 'todo',
    statusCategory: 'started',
  })
  expect(updated.issue).not.toHaveProperty('customerCompletionPreparationAt')
  expect(updated.issue).not.toHaveProperty('customerCompletionPreparationRevision')

  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Update: {
      ExpressionAttributeNames: expect.objectContaining({
        '#customerCompletionPreparationAt': 'customerCompletionPreparationAt',
        '#customerCompletionPreparationRevision': 'customerCompletionPreparationRevision',
      }),
      UpdateExpression: expect.stringContaining(
        'REMOVE #customerCompletionPreparationAt, #customerCompletionPreparationRevision',
      ),
    },
  })
  expect(Array.isArray(transactItems)
    ? transactItems.find((item) => {
        if (!isUnknownRecord(item) || !isUnknownRecord(item.Put)) return false
        return item.Put.TableName === 'AuditTable'
      })
    : undefined).toMatchObject({
    Put: {
      Item: {
        metadata: { completionReopened: true },
      },
    },
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

    expect(transactItems?.slice(2)).toMatchObject([
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
            workspaceId: 'FENCE#workspace-1',
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
      {
        Update: expect.objectContaining({
          TableName: 'PlanningTable',
          Key: {
            workspaceId: 'FENCE#workspace-1',
            recordKey: 'META',
          },
          UpdateExpression: expect.stringContaining('ADD #revision :increment'),
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
      let planningCondition: unknown
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
            planningCondition = transactItems[planningConditionIndex]
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
          code: 'PlanningRevisionConflict',
          status: 409,
        })
      } else {
        await expect(mutation).resolves.toMatchObject({
          issue: { revision: 2, dueDate: '2026-07-21' },
        })
      }
      expect(planningConditionIndex).toBe(2)
      expect(planningCondition).toEqual({
        ConditionCheck: expect.objectContaining({
          TableName: 'PlanningTable',
          Key: { workspaceId: 'FENCE#workspace-1', recordKey: 'META' },
          ExpressionAttributeValues: expect.objectContaining({
            ':authorization1': 4,
          }),
        }),
      })
    }
  })
})

test('DynamoDB Work Item create and update classify snapshot Planning races', async () => {
  await withTestEnvironment({
    MUKUROJI_WORKSPACE_ACCESS_TABLE: 'WorkspaceAccessTable',
    PLANNING_TABLE_NAME: 'PlanningTable',
  }, async () => {
    const currentIssue = createScheduleCascadeIssue('core-team', 'snapshot-race')
    const authorizationSnapshot = {
      workspaceId: 'workspace-1',
      memberKey: 'demo@example.com',
      workspaceMemberVersion: 3,
      planningRevision: 8,
    }

    for (const operation of ['create', 'update'] as const) {
      let planningConditionIndex = -1
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'QueryCommand') return { Items: [] }
          if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
          if (command.constructor.name === 'TransactWriteCommand') {
            const transactItems = command.input.TransactItems as Array<{
              ConditionCheck?: { TableName?: string }
            }>
            planningConditionIndex = transactItems.findIndex((item) =>
              item.ConditionCheck?.TableName === 'PlanningTable'
            )
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
              title: 'Snapshot race',
              assigneeUserId: 'demo@example.com',
              workflowSchemaVersion: 1,
              workflowStatusId: 'todo',
              statusCategory: 'unstarted',
              customFieldValues: {},
              schedule: createDueDateSchedule('2026-07-20'),
              priority: 'medium',
              authorizationSnapshot,
            },
            'demo@example.com',
          )
        : client.updateTeamIssue(
            'workspace-1',
            'core-team',
            'snapshot-race',
            {
              expectedRevision: 1,
              title: 'Updated snapshot race',
              authorizationSnapshot,
            },
            'demo@example.com',
          )

      await expect(mutation).rejects.toMatchObject({
        code: 'PlanningRevisionConflict',
        status: 409,
      })
      expect(planningConditionIndex).toBeGreaterThan(0)
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
      expect(transactItems).toHaveLength(auditEnabled ? 13 : 11)
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
      expect(transactItems.at(-2)).toMatchObject({
        Put: { TableName: 'DeveloperPlatformTable' },
      })
      expect(transactItems.at(-1)).toMatchObject({
        Update: { TableName: 'PlanningTable' },
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

test('DynamoDB Work Item schedule cascade preserves classified receipt preparation errors', async () => {
  const currentIssue = createScheduleCascadeIssue('core-team', 'root')
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') return { Item: currentIssue }
      throw new Error('The transaction must not start after receipt preparation fails.')
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.updateTeamIssueSchedules(
    'workspace-1',
    [{
      teamId: 'core-team',
      workItemId: 'root',
      expectedRevision: 1,
      schedule: createDueDateSchedule('2026-07-21'),
    }],
    [],
    'demo@example.com',
    undefined,
    [],
    undefined,
    {
      async prepare() {
        throw new ProjectDataError(
          409,
          'PlanningRevisionConflict',
          'Planning changed. Reload and try again.',
        )
      },
    },
  )).rejects.toMatchObject({
    code: 'PlanningRevisionConflict',
    status: 409,
  })
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
      workItemTypeId: 'incident',
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
  expect(auditItem?.changes).toEqual(expect.arrayContaining([
    { field: 'workItemTypeId', before: 'default', after: 'incident' },
  ]))
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
