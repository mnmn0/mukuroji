import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { withWorkItemKeyCounter } from '../../../../api/test-support/work-item-key-allocation'
import { createMutationAuditContext } from '../../../audit/audit'
import { DynamoDbTeamIssuesClient } from './work-item-client'

const criterion = { id: 'c'.repeat(32), text: 'Tests pass', satisfied: false }

/**
 * Creates a client whose table holds no Work Item, so every new Work Item ID is free.
 *
 * @returns The client and the transactions it sent.
 */
function createClient() {
  const transactions: TransactWriteCommand['input'][] = []
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  Object.assign(documentClient, {
    async send(command: unknown) {
      if (command instanceof GetCommand) return { Item: undefined }
      if (command instanceof TransactWriteCommand) transactions.push(command.input)
      return { Items: [] }
    },
  })
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    withWorkItemKeyCounter(documentClient),
    new DynamoDBClient({ region: 'us-east-1' }),
    false,
    'AuditTable',
  )
  return { client, transactions }
}

/**
 * Creates a Work Item with the given acceptance criteria value.
 *
 * @param client - Work Item client under test.
 * @param acceptanceCriteria - Value the API handler would pass to the adapter.
 * @returns The create response.
 */
function create(client: DynamoDbTeamIssuesClient, acceptanceCriteria: unknown) {
  return client.createTeamIssue(
    'workspace-1', 'core-team',
    {
      title: 'Plan the launch',
      assigneeUserId: 'sato@example.com',
      acceptanceCriteria,
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-03'),
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
    },
    'demo@example.com',
    createMutationAuditContext({
      workspaceId: 'workspace-1',
      actor: { id: 'demo@example.com', kind: 'user' },
      idempotencyKey: 'create-criteria',
      occurredAt: new Date().toISOString(),
      request: { method: 'POST', path: '/api/teams/core-team/issues' },
      source: { kind: 'api', requestId: 'create-criteria' },
    }),
  )
}

test('stores, returns, and audits acceptance criteria on a new Work Item', async () => {
  const { client, transactions } = createClient()

  const response = await create(client, [criterion])

  expect(response.issue.acceptanceCriteria).toEqual([criterion])
  const items = transactions[0]?.TransactItems ?? []
  expect(items.find((item) => item.Put?.TableName === 'IssuesTable')?.Put?.Item).toMatchObject({
    acceptanceCriteria: [criterion],
  })
  const changes: unknown = items.find((item) => item.Put?.TableName === 'AuditTable')?.Put?.Item?.changes
  expect(Array.isArray(changes) && changes.some((change: unknown) =>
    typeof change === 'object' && change !== null && Reflect.get(change, 'field') === 'acceptanceCriteria')).toBe(true)
})

test('rejects criteria the API handler has not normalized before writing', async () => {
  const { client, transactions } = createClient()

  await expect(create(client, [{ text: 'Tests pass' }])).rejects.toMatchObject({
    status: 400,
    code: 'InvalidAcceptanceCriteria',
  })
  expect(transactions).toEqual([])
})
