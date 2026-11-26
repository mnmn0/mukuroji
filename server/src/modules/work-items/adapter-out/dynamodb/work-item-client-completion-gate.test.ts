import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import { withWorkItemKeyCounter } from '../../../../api/test-support/work-item-key-allocation'
import { createMutationAuditContext } from '../../../audit/audit'
import { DynamoDbTeamIssuesClient } from './work-item-client'

/**
 * Builds a strict stored Work Item row.
 *
 * @param overrides - Fields replacing the defaults.
 * @returns The stored row.
 */
function storedIssue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
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
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-03'),
    priority: 'high',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Creates a client whose reads return one fixed row.
 *
 * @param stored - Row returned by every read.
 * @returns The client and the transactions it sent.
 */
function createClient(stored: Record<string, unknown>) {
  const transactions: TransactWriteCommand['input'][] = []
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  Object.assign(documentClient, {
    async send(command: unknown) {
      // Only the stored Work Item exists, so a new Work Item's ID is free.
      if (command instanceof GetCommand) {
        return { Item: command.input.Key?.issueId === stored.issueId ? stored : undefined }
      }
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
 * Creates an audit context for an update request.
 *
 * @returns Mutation audit context.
 */
function auditContext() {
  return createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'gate-override',
    occurredAt: new Date().toISOString(),
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'gate-override' },
  })
}

/**
 * Finds the Work Item update and audit put in a transaction.
 *
 * @param transaction - Sent transaction input.
 * @returns The update expression parts, audit field names, and audit metadata.
 */
function readUpdate(transaction: TransactWriteCommand['input'] | undefined) {
  const items = transaction?.TransactItems ?? []
  const update = items.find((item) => item.Update?.TableName === 'IssuesTable')?.Update
  const auditItem = items.find((item) => item.Put?.TableName === 'AuditTable')?.Put?.Item
  const changes: unknown = auditItem?.changes
  return {
    expression: update?.UpdateExpression ?? '',
    values: update?.ExpressionAttributeValues ?? {},
    auditFields: Array.isArray(changes)
      ? changes.map((change: unknown) =>
        typeof change === 'object' && change !== null ? Reflect.get(change, 'field') : undefined)
      : [],
    metadata: auditItem?.metadata,
  }
}

test('records a completion Gate override in the audit metadata and the activity summary', async () => {
  const { client, transactions } = createClient(storedIssue({ workflowStatusId: 'doing', statusCategory: 'started' }))

  await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    {
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
      expectedRevision: 1,
      completionGateOverridden: { reason: 'Accepted in review', conditions: ['acceptance-criteria'] },
    },
    'demo@example.com', auditContext(),
  )

  const items = transactions[0]?.TransactItems ?? []
  expect(readUpdate(transactions[0]).metadata).toMatchObject({
    completionGateOverride: { reason: 'Accepted in review', conditions: ['acceptance-criteria'] },
  })
  const event = items.find((item) => item.Put?.TableName === 'IssueEventsTable')?.Put?.Item
  expect(event).toMatchObject({
    eventType: 'updated',
    summary: 'Completed by overriding the completion Gate (acceptance-criteria): Accepted in review',
  })
  // The override is recorded with the update only; the Work Item row does not keep it.
  expect(readUpdate(transactions[0]).expression).not.toContain('completionGate')
})

test('keeps the ordinary summary for an update without an override', async () => {
  const { client, transactions } = createClient(storedIssue())

  await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { title: 'Wireframe v2', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )

  const event = transactions[0]?.TransactItems?.find((item) => item.Put?.TableName === 'IssueEventsTable')?.Put?.Item
  expect(event).toMatchObject({ summary: 'Issue was updated.' })
  expect(readUpdate(transactions[0]).metadata).not.toHaveProperty('completionGateOverride')
})
