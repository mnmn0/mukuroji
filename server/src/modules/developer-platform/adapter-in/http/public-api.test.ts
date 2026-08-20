import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  configureFakeAuthenticatedUser,
  configureFakeProjectClients,
  createAccessToken,
  createLambdaHttpEvent,
  createApiHandler,
  getTestAppDependencies,
  resetTestApp,
  withTestEnvironment,
} = createApiTestHarness()
import { DynamoDbTeamIssuesClient } from '../../../work-items'
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
import {
  WORK_ITEM_SCHEMA_VERSION,
  type DueDateWorkItemSchedule,
} from '@mukuroji/contracts'

/** Creates a canonical deadline-only schedule for Public API persistence fixtures. */
function createDueDateSchedule(dueDate = '2026-07-31'): DueDateWorkItemSchedule {
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

afterEach(() => {
  resetTestApp()
})

test('pages Public Work Items with a bounded updated-at GSI query and LastEvaluatedKey', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const createStoredIssue = (issueId: string, updatedAt: string) => ({
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#project-1',
    teamId: 'core-team',
    assignedProjectId: 'project-1',
    issueId,
    sortOrder: 1,
    title: `Issue ${issueId}`,
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    schedule: createDueDateSchedule(),
    priority: 'medium',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt,
  })
  const firstKey = {
    directoryTeamId: 'workspace-1#team#core-team',
    updatedAt: '2026-07-18T02:00:00.000Z',
    issueId: 'issue-2',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return command.input.ExclusiveStartKey
        ? { Items: [createStoredIssue('issue-1', '2026-07-18T01:00:00.000Z')] }
        : {
            Items: [createStoredIssue('issue-2', '2026-07-18T02:00:00.000Z')],
            LastEvaluatedKey: firstKey,
          }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const first = await client.getPublicWorkItemPage('workspace-1', 'core-team', {
    limit: 1,
    updatedAfter: '2026-07-18T00:00:00.000Z',
    accessibleProjectIds: ['project-1'],
  })
  const second = await client.getPublicWorkItemPage('workspace-1', 'core-team', {
    limit: 1,
    cursor: first.nextCursor,
    updatedAfter: '2026-07-18T00:00:00.000Z',
    accessibleProjectIds: ['project-1'],
  })
  await client.getPublicWorkItemPage('workspace-1', 'core-team', {
    limit: 1,
    accessibleProjectIds: ['project-1'],
  })

  expect(first.issues.map((issue) => issue.id)).toEqual(['issue-2'])
  expect(first.nextCursor).toBeString()
  expect(second.issues.map((issue) => issue.id)).toEqual(['issue-1'])
  expect(second.nextCursor).toBeUndefined()
  expect(sentInputs[0]).toMatchObject({
    TableName: 'issues-table',
    IndexName: 'TeamIssueUpdatedAtIndex',
    KeyConditionExpression:
      '#directoryTeamId = :directoryTeamId AND #updatedAt > :updatedAfter',
    Limit: 1,
    ScanIndexForward: false,
  })
  expect(sentInputs[1]?.ExclusiveStartKey).toEqual(firstKey)
  expect(sentInputs[2]).toMatchObject({
    KeyConditionExpression: '#directoryTeamId = :directoryTeamId',
    ExpressionAttributeNames: expect.not.objectContaining({
      '#updatedAt': 'updatedAt',
    }),
  })
})

test('returns an existing deterministic import row only when its request digest matches', async () => {
  const digest = 'a'.repeat(64)
  const issueId = `import-${'b'.repeat(48)}`
  const existing = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId,
    importRequestDigest: digest,
    sortOrder: 10,
    title: 'Imported once',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    schedule: createDueDateSchedule(),
    priority: 'medium',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'QueryCommand') return { Items: [] }
      if (command.constructor.name === 'GetCommand') return { Item: existing }
      const error = new Error('conditional collision') as Error & {
        CancellationReasons: Array<{ Code: string }>
      }
      error.name = 'TransactionCanceledException'
      error.CancellationReasons = [
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
      ]
      throw error
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const input = {
    title: 'Imported once',
    assigneeUserId: 'member@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    schedule: createDueDateSchedule(),
    priority: 'medium',
    idempotentIssueId: issueId,
    idempotentRequestDigest: digest,
  }

  await expect(client.createTeamIssue(
    'workspace-1',
    'core-team',
    input,
    'member@example.com',
  )).resolves.toMatchObject({ issue: { id: issueId, title: 'Imported once' } })
  await expect(client.createTeamIssue(
    'workspace-1',
    'core-team',
    { ...input, idempotentRequestDigest: 'c'.repeat(64) },
    'member@example.com',
  )).rejects.toMatchObject({
    status: 409,
    code: 'IdempotentWorkItemCreateConflict',
  })
})

test('accepts the deterministic public API Work Item ID namespace', async () => {
  let transactionInput: TransactWriteCommandInput | undefined
  const documentClient = {
    async send(command: { constructor: { name: string }; input?: TransactWriteCommandInput }) {
      if (command.constructor.name === 'QueryCommand') return { Items: [] }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactionInput = command.input
        return {}
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const issueId = `api-${'d'.repeat(48)}`

  await expect(client.createTeamIssue(
    'workspace-1',
    'core-team',
    {
      title: 'Created through the public API',
      assigneeUserId: 'member@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: createDueDateSchedule(),
      priority: 'medium',
      idempotentIssueId: issueId,
      idempotentRequestDigest: 'e'.repeat(64),
    },
    'member@example.com',
  )).resolves.toMatchObject({ issue: { id: issueId } })
  expect(transactionInput?.TransactItems?.[0]?.Put?.Item).toMatchObject({
    issueId,
    importRequestDigest: 'e'.repeat(64),
  })
})

test('rejects a status-only canonical row instead of upcasting workflow fields', async () => {
  const documentClient = {
    async send() {
      return {
        Item: {
          schemaVersion: 1,
          revision: 1,
          directoryId: 'workspace-1',
          directoryTeamId: 'workspace-1#team#core-team',
          teamId: 'core-team',
          issueId: 'legacy-shaped-row',
          sortOrder: 1,
          title: 'Legacy-shaped row',
          assigneeUserId: 'member@example.com',
          status: 'todo',
          dueDate: '2026/07/12',
          priority: 'medium',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core-team',
    'legacy-shaped-row',
    { eventLimit: 0 },
  )).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
})

test('rejects legacy-only display fields on canonical rows', async () => {
  const canonicalItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'strict-row',
    sortOrder: 1,
    title: 'Strict row',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-12',
    schedule: createDueDateSchedule('2026-07-12'),
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  for (const legacyField of [
    'titleKey',
    'assignee',
    'assigneeKey',
    'source',
    'migrationSource',
    'migrationSourceKey',
    'relationIds',
  ] as const) {
    const documentClient = {
      async send() {
        return {
          Item: {
            ...canonicalItem,
            [legacyField]: 'legacy-display-value',
          },
        }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'issues-table',
      'events-table',
      documentClient,
      {} as DynamoDBClient,
      false,
    )

    await expect(client.getTeamIssueDetail(
      'workspace-1',
      'core-team',
      'strict-row',
      { eventLimit: 0 },
    )).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
  }
})

test('serves the same authenticated API contract from Function URL root and /api paths', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: '   ',
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
      MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production',
    },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'Demo@Example.com',
        'custom:directory_id': 'workspace#production',
        'custom:workspace_id': 'workspace#production',
      })
      const accessToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_mukuroji',
        token_use: 'access',
      })

      const testHandler = createApiHandler(getTestAppDependencies())
      const directResponse = await testHandler(
        createLambdaHttpEvent('/teams/projects', accessToken),
      )
      const prefixedResponse = await testHandler(
        createLambdaHttpEvent('/api/teams/projects', accessToken),
      )

      expect(directResponse.statusCode).toBe(200)
      expect(prefixedResponse.statusCode).toBe(200)
      expect(JSON.parse(directResponse.body)).toEqual(JSON.parse(prefixedResponse.body))
      expect(calls.directoryReads).toEqual([
        { directoryId: 'workspace#production', locale: 'ja' },
        { consistentRead: true, directoryId: 'workspace#production', locale: 'ja' },
        { directoryId: 'workspace#production', locale: 'ja' },
        { consistentRead: true, directoryId: 'workspace#production', locale: 'ja' },
      ])
    },
  )
})
