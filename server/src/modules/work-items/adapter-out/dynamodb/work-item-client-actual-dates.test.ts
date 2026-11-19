import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  toWorkspaceLocalDate,
} from '@mukuroji/contracts'
import { withWorkItemKeyCounter } from '../../../../api/test-support/work-item-key-allocation'
import { createMutationAuditContext } from '../../../audit/audit'
import { ProjectDataError } from '../../../directory'
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
    idempotencyKey: 'actual-dates',
    occurredAt: new Date().toISOString(),
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'actual-dates' },
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

/** Today's local date under the default UTC calendar policy. */
// The default calendar policy uses the Workspace time zone, so "today" is its local date.
const today = () => toWorkspaceLocalDate(new Date())

test('records the actual start when work starts and audits it', async () => {
  const { client, transactions } = createClient(storedIssue())

  const response = await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { workflowSchemaVersion: 1, workflowStatusId: 'doing', statusCategory: 'started', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )

  expect(response.issue.actualStartDate).toBe(today())
  expect(response.issue.actualEndDate).toBeUndefined()
  const update = readUpdate(transactions[0])
  expect(update.expression).toContain('#actualStartDate = :actualStartDate')
  expect(update.values[':actualStartDate']).toBe(today())
  expect(update.auditFields).toContain('actualStartDate')
})

test('records the actual end on completion and removes it on reopen', async () => {
  const completed = createClient(storedIssue({
    workflowStatusId: 'doing', statusCategory: 'started', actualStartDate: '2026-05-20',
  }))
  const completion = await completed.client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { workflowSchemaVersion: 1, workflowStatusId: 'done', statusCategory: 'completed', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
  expect(completion.issue).toMatchObject({ actualStartDate: '2026-05-20', actualEndDate: today() })
  const completionUpdate = readUpdate(completed.transactions[0])
  expect(completionUpdate.expression).toContain('#actualEndDate = :actualEndDate')
  expect(completionUpdate.expression).not.toContain('#actualStartDate')

  const reopened = createClient(storedIssue({
    workflowStatusId: 'done', statusCategory: 'completed', actualStartDate: '2026-05-20', actualEndDate: '2026-05-25',
  }))
  const reopen = await reopened.client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { workflowSchemaVersion: 1, workflowStatusId: 'doing', statusCategory: 'started', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
  expect(reopen.issue.actualStartDate).toBe('2026-05-20')
  expect(reopen.issue.actualEndDate).toBeUndefined()
  expect(readUpdate(reopened.transactions[0]).expression).toMatch(/REMOVE .*#actualEndDate/u)
})

test('leaves a completed row without actual dates unchanged on an unrelated edit', async () => {
  const { client, transactions } = createClient(storedIssue({ workflowStatusId: 'done', statusCategory: 'completed' }))

  const response = await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { title: 'Wireframe v2', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )

  expect(response.issue.actualStartDate).toBeUndefined()
  expect(response.issue.actualEndDate).toBeUndefined()
  expect(readUpdate(transactions[0]).expression).not.toContain('actual')
})

test('applies and audits a manager correction', async () => {
  const { client, transactions } = createClient(storedIssue({
    workflowStatusId: 'done', statusCategory: 'completed', actualStartDate: '2026-05-20', actualEndDate: '2026-05-25',
  }))

  const response = await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { actualDateCorrection: { actualStartDate: '2026-05-18', actualEndDate: '2026-05-24' }, expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )

  expect(response.issue).toMatchObject({ actualStartDate: '2026-05-18', actualEndDate: '2026-05-24' })
  const update = readUpdate(transactions[0])
  expect(update.auditFields).toEqual(expect.arrayContaining(['actualStartDate', 'actualEndDate']))
  expect(update.metadata).toMatchObject({ actualDateCorrection: true })
})

test('rejects an invalid correction before writing', async () => {
  const { client, transactions } = createClient(storedIssue({ workflowStatusId: 'doing', statusCategory: 'started' }))

  await expect(client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { actualDateCorrection: { actualStartDate: '2026-05-18', actualEndDate: '2026-05-24' }, expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )).rejects.toMatchObject({ status: 400, code: 'InvalidWorkItemActualDates' })
  await expect(client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { actualDateCorrection: { actualStartDate: '9999-01-01' }, expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )).rejects.toBeInstanceOf(ProjectDataError)
  expect(transactions).toEqual([])
})

test('records both actual dates when a Work Item is created completed', async () => {
  const { client, transactions } = createClient(storedIssue())

  const response = await client.createTeamIssue(
    'workspace-1', 'core-team',
    {
      title: 'Done on arrival',
      assigneeUserId: 'sato@example.com',
      schedule: createDefaultDueDateWorkItemSchedule('2026-06-03'),
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
      customFieldValues: {},
    },
    'demo@example.com',
  )

  expect(response.issue).toMatchObject({ actualStartDate: today(), actualEndDate: today() })
  const put = transactions[0]?.TransactItems?.find((item) => item.Put?.TableName === 'IssuesTable')?.Put
  expect(put?.Item).toMatchObject({ actualStartDate: today(), actualEndDate: today() })
})
