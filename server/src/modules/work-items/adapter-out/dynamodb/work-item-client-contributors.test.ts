import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type WorkItemContributorAssignment,
} from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../../audit/audit'
import { ProjectDataError } from '../../../directory'
import { DynamoDbTeamIssuesClient } from './work-item-client'

const criterion = { id: 'c'.repeat(32), text: 'Tests pass', satisfied: true }

const contributor: WorkItemContributorAssignment = {
  assignmentId: 'a'.repeat(32),
  memberUserId: 'suzuki@example.com',
  jobRoleId: 'designer',
  plannedEffortMinutes: 90,
  status: 'planned',
}

/**
 * Builds a strict stored Work Item row.
 *
 * @param contributorAssignments - Contributors stored on the row, if any.
 * @returns The stored row.
 */
function storedIssue(contributorAssignments?: WorkItemContributorAssignment[]) {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    teamId: 'core-team',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    ...(contributorAssignments ? { contributorAssignments } : {}),
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-03',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-03'),
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
}

/**
 * Creates a client whose DynamoDB calls are answered from fixed rows.
 *
 * @param before - Row returned by the first read.
 * @param after - Row returned by later reads.
 * @returns The client and the transactions it sent.
 */
function createClient(before: Record<string, unknown>, after: Record<string, unknown>) {
  const transactions: TransactWriteCommand['input'][] = []
  let reads = 0
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  Object.assign(documentClient, {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        reads += 1
        return { Item: reads === 1 ? before : after }
      }
      if (command instanceof TransactWriteCommand) transactions.push(command.input)
      return {}
    },
  })
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
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
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'contributors',
    occurredAt: '2026-07-20T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'contributors' },
  })
}

/**
 * Finds the Work Item update and audit put in a transaction.
 *
 * @param transaction - Sent transaction input.
 * @returns The update expression parts and the audit field names that changed.
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
  }
}

test('persists, returns, and audits a replacement contributor list', async () => {
  const { client, transactions } = createClient(storedIssue(), { ...storedIssue([contributor]), revision: 2 })

  const response = await client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    { contributorAssignments: [contributor], expectedRevision: 1 },
    'demo@example.com',
    auditContext(),
  )

  expect(response.issue.contributorAssignments).toEqual([contributor])
  expect(response.issue.assigneeUserId).toBe('sato@example.com')
  const update = readUpdate(transactions[0])
  expect(update.expression).toContain('#contributorAssignments = :contributorAssignments')
  expect(update.values[':contributorAssignments']).toEqual([contributor])
  expect(update.auditFields).toContain('contributorAssignments')
})

test('removes the attribute when every contributor is cleared', async () => {
  const { client, transactions } = createClient(storedIssue([contributor]), { ...storedIssue(), revision: 2 })

  const response = await client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    { contributorAssignments: [], expectedRevision: 1 },
    'demo@example.com',
    auditContext(),
  )

  expect(response.issue.contributorAssignments).toBeUndefined()
  const update = readUpdate(transactions[0])
  expect(update.expression).toMatch(/REMOVE .*#contributorAssignments/u)
  expect(update.values[':contributorAssignments']).toBeUndefined()
})

test('rejects a malformed contributor list before writing', async () => {
  const { client, transactions } = createClient(storedIssue(), storedIssue())

  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    { contributorAssignments: [{ memberUserId: 'suzuki@example.com' }], expectedRevision: 1 },
    'demo@example.com',
  )).rejects.toBeInstanceOf(ProjectDataError)
  expect(transactions).toEqual([])
})

test('persists, returns, and audits acceptance criteria, and removes them with an empty list', async () => {
  const set = createClient(storedIssue(), { ...storedIssue(), acceptanceCriteria: [criterion], revision: 2 })
  const response = await set.client.updateTeamIssue(
    'user#demo@example.com', 'core-team', 'wireframe',
    { acceptanceCriteria: [criterion], expectedRevision: 1 }, 'demo@example.com', auditContext(),
  )
  expect(response.issue.acceptanceCriteria).toEqual([criterion])
  const written = readUpdate(set.transactions[0])
  expect(written.expression).toContain('#acceptanceCriteria = :acceptanceCriteria')
  expect(written.values[':acceptanceCriteria']).toEqual([criterion])
  expect(written.auditFields).toContain('acceptanceCriteria')

  const cleared = createClient({ ...storedIssue(), acceptanceCriteria: [criterion] }, { ...storedIssue(), revision: 2 })
  const clearedResponse = await cleared.client.updateTeamIssue(
    'user#demo@example.com', 'core-team', 'wireframe',
    { acceptanceCriteria: [], expectedRevision: 1 }, 'demo@example.com', auditContext(),
  )
  expect(clearedResponse.issue.acceptanceCriteria).toBeUndefined()
  expect(readUpdate(cleared.transactions[0]).expression).toMatch(/REMOVE .*#acceptanceCriteria/u)

  // The adapter re-checks the stored shape, so an unvalidated caller cannot persist a malformed list.
  const malformed = createClient(storedIssue(), storedIssue())
  await expect(malformed.client.updateTeamIssue(
    'user#demo@example.com', 'core-team', 'wireframe',
    { acceptanceCriteria: [{ text: 'No ID' }], expectedRevision: 1 }, 'demo@example.com',
  )).rejects.toBeInstanceOf(ProjectDataError)
  expect(malformed.transactions).toEqual([])
})
