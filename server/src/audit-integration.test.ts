import { afterEach, expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from './audit'
import {
  app,
  configureApiClientsForTest,
  DynamoDbProjectDirectoryClient,
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
  resetApiClientsForTest,
} from './index'

const workspaceId = 'workspace-1'
const actorUserId = 'demo@example.com'
const occurredAt = '2026-07-11T12:00:00.000Z'

afterEach(() => {
  resetApiClientsForTest()
})

test('project task mutations write state and audit atomically with deterministic event IDs', async () => {
  let taskQueryCount = 0
  const recording = createRecordingDocumentClient((name) => {
    if (name !== 'QueryCommand') {
      return {}
    }

    taskQueryCount += 1
    return taskQueryCount === 1
      ? { Items: [] }
      : {
          Items: [{
            directoryId: workspaceId,
            directoryProjectId: `${workspaceId}#project#refero`,
            projectId: 'refero',
            taskId: 'prepare-audit-launch',
            sortOrder: 10,
            title: 'Prepare audit launch',
            assigneeUserId: actorUserId,
            status: 'todo',
            dueDate: '2026/07/31',
            priority: 'high',
          }],
        }
  })
  const client = new DynamoDbProjectTasksClient(
    'TasksTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )
  const input = {
    title: 'Prepare audit launch',
    assigneeUserId: actorUserId,
    status: 'todo' as const,
    dueDate: '2026/07/31',
    priority: 'high' as const,
  }

  await client.createProjectTask(
    workspaceId,
    'refero',
    input,
    createAuditContext('stable-task-request'),
  )
  await client.createProjectTask(
    workspaceId,
    'refero',
    input,
    createAuditContext('stable-task-request'),
  )

  const transactions = recording.commands.filter((command) => command.name === 'TransactWriteCommand')

  expect(transactions).toHaveLength(2)
  const firstItems = readTransactItems(transactions[0])
  const secondItems = readTransactItems(transactions[1])

  expect(firstItems).toHaveLength(2)
  expect(firstItems[0]).toMatchObject({
    Put: {
      TableName: 'TasksTable',
      Item: {
        directoryId: workspaceId,
        projectId: 'refero',
        taskId: 'prepare-audit-launch',
      },
    },
  })
  expect(firstItems[1]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        directoryId: workspaceId,
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: 'project/refero/task/prepare-audit-launch',
        actorUserId,
        outboxStatus: 'pending',
      },
    },
  })
  expect(secondItems[0]).toMatchObject({
    Put: {
      Item: {
        taskId: 'prepare-audit-launch-2',
      },
    },
  })
  expect(readAuditEvent(secondItems[1]).entityId).toBe(
    'project/refero/task/prepare-audit-launch-2',
  )
  expect(readAuditEvent(firstItems[1]).eventId).toBe(readAuditEvent(secondItems[1]).eventId)
})

test('project directory mutations write state and audit in one transaction', async () => {
  const recording = createRecordingDocumentClient((name) =>
    name === 'QueryCommand' ? { Items: [] } : {},
  )
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeam(
    workspaceId,
    { name: 'Core Team' },
    createAuditContext('create-core-team'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({
    Put: {
      TableName: 'DirectoryTable',
      Item: {
        directoryId: workspaceId,
        entryType: 'team',
        teamId: 'core-team',
      },
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'project.created',
        entityType: 'project',
        entityId: 'team/core-team',
        action: 'created',
      },
    },
  })
})

test('team issue mutations keep state, specialized activity, and generic audit atomic', async () => {
  const recording = createRecordingDocumentClient((name) =>
    name === 'QueryCommand' ? { Items: [] } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeamIssue(
    workspaceId,
    'core-team',
    {
      title: 'Ship audit trail',
      assigneeUserId: actorUserId,
      status: 'todo',
      dueDate: '2026/07/31',
      priority: 'high',
    },
    actorUserId,
    [],
    createAuditContext('create-team-issue'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(3)
  expect(items[0]).toMatchObject({
    Put: {
      TableName: 'IssuesTable',
      Item: {
        directoryId: workspaceId,
        teamId: 'core-team',
        issueId: 'ship-audit-trail',
      },
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'IssueEventsTable',
      Item: {
        issueId: 'ship-audit-trail',
        eventType: 'created',
      },
    },
  })
  expect(items[2]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: 'team/core-team/issue/ship-audit-trail',
        action: 'created',
      },
    },
  })
})

test('team issue audit diff is guarded by the pre-read updatedAt revision', async () => {
  const issueItem = createTeamIssueItem('issue-1')
  const recording = createRecordingDocumentClient((name) =>
    name === 'GetCommand' ? { Item: issueItem } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.updateTeamIssue(
    workspaceId,
    'core-team',
    'issue-1',
    { status: 'done' },
    actorUserId,
    createAuditContext('update-team-issue'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const stateUpdate = readTransactItems(transaction)[0]?.Update

  expect(stateUpdate).toMatchObject({
    ConditionExpression:
      'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #updatedAt = :beforeUpdatedAt',
    ExpressionAttributeValues: {
      ':beforeUpdatedAt': occurredAt,
    },
  })
})

test('comment mutation condition-checks its parent and writes specialized and generic events atomically', async () => {
  const issueItem = createTeamIssueItem('issue-1')
  const recording = createRecordingDocumentClient((name) =>
    name === 'GetCommand' ? { Item: issueItem } : {},
  )
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    recording.client,
    undefined,
    false,
    'AuditTable',
  )

  await client.createTeamIssueComment(
    workspaceId,
    'core-team',
    'issue-1',
    { body: 'Please review the audit event.' },
    actorUserId,
    createAuditContext('comment-request'),
  )

  const transaction = recording.commands.find((command) => command.name === 'TransactWriteCommand')
  const items = readTransactItems(transaction)

  expect(items).toHaveLength(3)
  expect(items[0]).toEqual({
    ConditionCheck: {
      TableName: 'IssuesTable',
      Key: {
        directoryTeamId: `${workspaceId}#team#core-team`,
        issueId: 'issue-1',
      },
      ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      TableName: 'IssueEventsTable',
      Item: {
        issueId: 'issue-1',
        eventType: 'commented',
        body: 'Please review the audit event.',
      },
    },
  })
  const specializedEvent = readPutItem(items[1])

  expect(items[2]).toMatchObject({
    Put: {
      TableName: 'AuditTable',
      Item: {
        eventType: 'comment.created',
        entityType: 'work-item',
        entityId: 'team/core-team/issue/issue-1',
        targetType: 'comment',
        targetId: `team/core-team/issue/issue-1/comment/${String(specializedEvent.eventId)}`,
      },
    },
  })
})

test('workspace audit requires system admin and forwards pagination filters', async () => {
  const queries: Array<Record<string, unknown>> = []
  configureApiClientsForTest({
    cognito: createCognitoClient(),
    auditEvents: {
      async query(input) {
        queries.push({ ...input })
        return { events: [], nextCursor: 'next-audit-page' }
      },
    },
  })

  const denied = await app.request('/api/audit/events?limit=25', {
    headers: { Authorization: `Bearer ${createAccessToken([])}` },
  })

  expect(denied.status).toBe(403)
  expect(queries).toEqual([])

  const response = await app.request(
    '/api/audit/events?actorUserId=actor-2&eventType=work-item.updated&limit=25&cursor=cursor-1',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ events: [], nextCursor: 'next-audit-page' })
  expect(queries).toEqual([
    expect.objectContaining({
      workspaceId,
      actorId: 'actor-2',
      eventTypes: ['work-item.updated'],
      limit: 25,
      cursor: 'cursor-1',
      direction: 'descending',
    }),
  ])
})

test('issue activity authorizes the parent and forwards its pagination cursor', async () => {
  const queries: Array<Record<string, unknown>> = []
  const projectDirectory = {
    async getProjectDirectory() {
      return {
        teams: [
          {
            id: 'core-team',
            name: 'Core Team',
            expanded: true,
            projects: [],
          },
          {
            id: 'design-team',
            name: 'Design Team',
            expanded: true,
            projects: [],
          },
        ],
      }
    },
  } as unknown as NonNullable<
    Parameters<typeof configureApiClientsForTest>[0]['projectDirectory']
  >
  const teamIssues = {
    async getTeamIssueDetail(_directoryId: string, teamId: string) {
      return {
        issue: {
          id: 'issue-1',
          teamId,
          title: 'Audit integration',
          assigneeUserId: actorUserId,
          status: 'todo' as const,
          dueDate: '2026/07/31',
          priority: 'high' as const,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          source: 'dynamodb' as const,
        },
        comments: [],
        activity: [],
      }
    },
  } as unknown as NonNullable<Parameters<typeof configureApiClientsForTest>[0]['teamIssues']>
  configureApiClientsForTest({
    cognito: createCognitoClient(),
    projectDirectory,
    teamIssues,
    auditEvents: {
      async query(input) {
        queries.push({ ...input })
        return { events: [], nextCursor: 'next-activity-page' }
      },
    },
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/activity?limit=2&cursor=activity-cursor',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ events: [], nextCursor: 'next-activity-page' })
  const otherTeamResponse = await app.request(
    '/api/teams/design-team/issues/issue-1/activity?limit=2',
    {
      headers: {
        Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      },
    },
  )

  expect(otherTeamResponse.status).toBe(200)
  expect(queries).toEqual([
    expect.objectContaining({
      workspaceId,
      entityType: 'work-item',
      entityId: 'team/core-team/issue/issue-1',
      limit: 2,
      cursor: 'activity-cursor',
    }),
    expect.objectContaining({
      workspaceId,
      entityType: 'work-item',
      entityId: 'team/design-team/issue/issue-1',
      limit: 2,
    }),
  ])
})

/**
 * 固定 actor と timestamp を使う mutation audit context を作成します。
 */
function createAuditContext(idempotencyKey: string) {
  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: actorUserId,
      kind: 'user',
      displayName: 'Demo User',
    },
    idempotencyKey,
    correlationId: idempotencyKey,
    occurredAt,
    request: {
      method: 'POST',
      path: '/api/test-mutation',
      body: { stable: true },
    },
    source: {
      kind: 'api',
      requestId: 'request-1',
    },
  })
}

/**
 * AWS command を記録する mock DocumentClient を作成します。
 */
function createRecordingDocumentClient(
  respond: (name: string, input: Record<string, unknown>) => Record<string, unknown>,
) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name
      commands.push({ name, input: command.input })

      return respond(name, command.input)
    },
  } as unknown as DynamoDBDocumentClient

  return { client, commands }
}

/**
 * 記録済み command から transaction item を厳格に読み取ります。
 */
function readTransactItems(
  command: { name: string; input: Record<string, unknown> } | undefined,
) {
  const items = command?.input.TransactItems

  if (!Array.isArray(items) || !items.every(isRecord)) {
    throw new TypeError('Expected a TransactWriteCommand with object TransactItems.')
  }

  return items
}

/**
 * transaction item の Put payload から保存 item を読み取ります。
 */
function readPutItem(item: Record<string, unknown> | undefined) {
  const put = item?.Put

  if (!isRecord(put) || !isRecord(put.Item)) {
    throw new TypeError('Expected a transaction Put item.')
  }

  return put.Item
}

/**
 * transaction item から汎用 audit event を読み取ります。
 */
function readAuditEvent(item: Record<string, unknown> | undefined) {
  const event = readPutItem(item)

  if (typeof event.eventId !== 'string') {
    throw new TypeError('Expected an audit event ID.')
  }

  return event
}

/**
 * comment integration test 用の有効な Team Issue item を作成します。
 */
function createTeamIssueItem(issueId: string) {
  return {
    directoryId: workspaceId,
    directoryTeamId: `${workspaceId}#team#core-team`,
    teamId: 'core-team',
    issueId,
    sortOrder: 10,
    title: 'Audit integration',
    assigneeUserId: actorUserId,
    status: 'todo',
    dueDate: '2026/07/31',
    priority: 'high',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

/**
 * app integration test で使う Cognito client stub を作成します。
 */
function createCognitoClient() {
  return {
    async initiatePasswordAuth(_email: string, _password: string) {
      return {}
    },
    async getUser(_accessToken: string) {
      return {
        Username: actorUserId,
        UserAttributes: [
          { Name: 'email', Value: actorUserId },
          { Name: 'custom:directory_id', Value: workspaceId },
        ],
      }
    },
    async listUsers(_input: unknown) {
      return { users: [] }
    },
    async getUserProfile(userId: string) {
      return {
        id: userId,
        username: userId,
        email: userId,
      }
    },
  }
}

/**
 * Cognito group claim を含む test access token を作成します。
 */
function createAccessToken(groups: string[]) {
  const payload = Buffer.from(JSON.stringify({ 'cognito:groups': groups })).toString('base64url')

  return `header.${payload}.signature`
}

/**
 * 値が non-array object かどうかを判定します。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
