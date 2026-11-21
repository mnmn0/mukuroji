import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type ProjectScheduleBaselineEntry,
} from '@mukuroji/contracts'
import { withWorkItemKeyCounter } from '../../../../api/test-support/work-item-key-allocation'
import { createMutationAuditContext } from '../../../audit/audit'
import { DynamoDbProjectScheduleBaselineStore } from './schedule-baseline-store'
import { DynamoDbTeamIssuesClient } from './work-item-client'

/** Planning table holding the baseline rows in these tests. */
const PLANNING_TABLE = 'PlanningTable'

/**
 * Builds a strict stored Work Item row in Project `launch`.
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
    assignedProjectId: 'launch',
    directoryProjectId: 'workspace-1#project#launch',
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
 * Produces the stored active-baseline row the baseline store writes for one capture.
 *
 * @param entries - Entries of the captured baseline.
 * @returns The Planning table row.
 */
async function storedBaselineRow(entries: ProjectScheduleBaselineEntry[]) {
  let row: Record<string, unknown> | undefined
  const client = {
    async send(command: unknown) {
      if (command instanceof TransactWriteCommand) {
        const put = command.input.TransactItems?.find((item) =>
          item.Put?.TableName === PLANNING_TABLE && item.Put.Item?.recordKey === 'PROJECT_SCHEDULE_BASELINE#core-team#launch'
        )?.Put?.Item
        row = put
      }
      return {}
    },
  }
  const store = new DynamoDbProjectScheduleBaselineStore(PLANNING_TABLE, Object.assign(Object.create(null), client))
  const capturedAt = '2026-05-10T00:00:00.000Z'
  const baseline = { revision: 1, id: 'b1', capturedAt, entries }
  await store.write({
    workspaceId: 'workspace-1',
    teamId: 'core-team',
    projectId: 'launch',
    kind: 'capture',
    writtenAt: capturedAt,
    baseline,
    expectedRevision: 0,
    savedBaselines: [{ id: 'b1', capturedAt, entryCount: entries.length }],
    savedRowsToPut: [baseline],
    savedIdsToDelete: [],
    previous: null,
    callerAuthorization: [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }],
    auditContext: auditContext(),
  })
  if (!row) throw new Error('The baseline store did not write the active row.')
  return row
}

/**
 * Creates a client whose reads return one fixed Work Item and, optionally, one baseline row.
 *
 * @param stored - Work Item row, or rows, returned by Work Item reads with a matching ID.
 * @param baselineRow - Active baseline row, or `'throttled'` to fail its read.
 * @param failBaselineFence - Cancels each transaction on its active-baseline check, as if the
 *   baseline changed after it was read.
 * @returns The client, the transactions it sent, and the count of baseline reads.
 */
function createClient(
  stored: Record<string, unknown> | Array<Record<string, unknown>>,
  baselineRow?: Record<string, unknown> | 'throttled',
  failBaselineFence = false,
) {
  const rows = Array.isArray(stored) ? stored : [stored]
  const transactions: TransactWriteCommand['input'][] = []
  const reads = { baseline: 0 }
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }))
  Object.assign(documentClient, {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        if (command.input.TableName === PLANNING_TABLE) {
          reads.baseline += 1
          if (baselineRow === 'throttled') throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
          return { Item: baselineRow }
        }
        return { Item: rows.find((row) => row.issueId === command.input.Key?.issueId) }
      }
      if (command instanceof TransactWriteCommand) {
        transactions.push(command.input)
        if (failBaselineFence) {
          throw Object.assign(new Error('cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: (command.input.TransactItems ?? []).map((item) => ({
              Code: readBaselineFence({ TransactItems: [item] }) ? 'ConditionalCheckFailed' : 'None',
            })),
          })
        }
      }
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
    PLANNING_TABLE,
  )
  return { client, transactions, reads }
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
    idempotencyKey: 'baseline-slip',
    occurredAt: new Date().toISOString(),
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'baseline-slip' },
  })
}

/**
 * Reads the audit item of the Work Item update in a transaction.
 *
 * @param transaction - Sent transaction input.
 * @returns The audit summary and metadata.
 */
function readAudit(transaction: TransactWriteCommand['input'] | undefined) {
  const item = transaction?.TransactItems?.find((entry) => entry.Put?.TableName === 'AuditTable')?.Put?.Item
  const metadata: unknown = item?.metadata
  if (typeof metadata !== 'object' || metadata === null) throw new Error('The update wrote no audit metadata.')
  return {
    summary: item?.summary,
    baselineSlip: Reflect.get(metadata, 'baselineSlip'),
    candidates: Reflect.get(metadata, 'notificationCandidates'),
  }
}

/**
 * Lists the active-baseline checks of a transaction.
 *
 * @param transaction - Sent transaction input.
 * @returns The ConditionCheck items on active baseline rows.
 */
function readBaselineFences(transaction: TransactWriteCommand['input'] | undefined) {
  return (transaction?.TransactItems ?? []).flatMap((item) =>
    item.ConditionCheck?.TableName === PLANNING_TABLE &&
      String(item.ConditionCheck.Key?.recordKey).startsWith('PROJECT_SCHEDULE_BASELINE#')
      ? [item.ConditionCheck]
      : []
  )
}

/**
 * Reads the only active-baseline check of a transaction.
 *
 * @param transaction - Sent transaction input.
 * @returns The check, or undefined when there is none.
 */
function readBaselineFence(transaction: TransactWriteCommand['input'] | undefined) {
  return readBaselineFences(transaction)[0]
}

/**
 * Moves the stored Work Item's deadline.
 *
 * @param client - Work Item client under test.
 * @param dueDate - New deadline.
 * @returns The update response.
 */
async function moveDeadline(client: DynamoDbTeamIssuesClient, dueDate: string) {
  return await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { schedule: createDefaultDueDateWorkItemSchedule(dueDate), expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
}

test('records the slip and notifies the assignee when a deadline crosses three days behind the baseline', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-06-01' }])
  const { client, transactions } = createClient(storedIssue(), baselineRow)

  await moveDeadline(client, '2026-06-05')

  const audit = readAudit(transactions[0])
  expect(audit.baselineSlip).toEqual({
    baselineRevision: 1,
    baselineEndDate: '2026-06-01',
    previousDelayDays: 2,
    delayDays: 4,
  })
  expect(audit.candidates).toContainEqual({ memberKey: 'sato@example.com', reason: 'baseline-slip' })
  expect(audit.summary).toBe('Work Item now ends 4 days after its schedule baseline.')
})

test('records a smaller slip for Automation without notifying', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-06-03' }])
  const { client, transactions } = createClient(storedIssue(), baselineRow)

  await moveDeadline(client, '2026-06-04')

  const audit = readAudit(transactions[0])
  expect(audit.baselineSlip).toEqual({
    baselineRevision: 1,
    baselineEndDate: '2026-06-03',
    previousDelayDays: 0,
    delayDays: 1,
  })
  expect(audit.candidates).not.toContainEqual(expect.objectContaining({ reason: 'baseline-slip' }))
  expect(audit.summary).toBe('Work Item schedule changed.')
})

test('records nothing when the deadline moves earlier or the item is outside the baseline', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-05-25' }])
  const earlier = createClient(storedIssue(), baselineRow)
  await moveDeadline(earlier.client, '2026-06-02')
  expect(readAudit(earlier.transactions[0]).baselineSlip).toBeUndefined()

  const otherRow = await storedBaselineRow([{ workItemId: 'other-item', endDate: '2026-05-25' }])
  const outside = createClient(storedIssue(), otherRow)
  await moveDeadline(outside.client, '2026-06-20')
  expect(readAudit(outside.transactions[0]).baselineSlip).toBeUndefined()
})

test('does not read the baseline for edits that cannot move the end, or for items outside a Project', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-05-25' }])
  const titleOnly = createClient(storedIssue(), baselineRow)
  await titleOnly.client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { title: 'Wireframe v2', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
  expect(titleOnly.reads.baseline).toBe(0)

  const started = createClient(storedIssue(), baselineRow)
  await started.client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { workflowSchemaVersion: 1, workflowStatusId: 'doing', statusCategory: 'started', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
  expect(started.reads.baseline).toBe(0)

  const { assignedProjectId: _project, directoryProjectId: _directoryProject, ...unassigned } = storedIssue()
  const noProject = createClient(unassigned, baselineRow)
  await moveDeadline(noProject.client, '2026-06-20')
  expect(noProject.reads.baseline).toBe(0)
})

test('keeps the edit when the baseline storage is temporarily unavailable', async () => {
  const { client, transactions, reads } = createClient(storedIssue(), 'throttled')

  const response = await moveDeadline(client, '2026-06-20')

  expect(reads.baseline).toBe(1)
  expect(response.issue.dueDate).toBe('2026-06-20')
  expect(readAudit(transactions[0]).baselineSlip).toBeUndefined()
})

test('reads the baseline once per Project for a dependency cascade and records each slip', async () => {
  const baselineRow = await storedBaselineRow([
    { workItemId: 'wireframe', endDate: '2026-06-01' },
    { workItemId: 'review', endDate: '2026-06-03' },
  ])
  const { client, transactions, reads } = createClient([
    storedIssue(),
    storedIssue({ issueId: 'review', title: 'Review', dueDate: '2026-06-03', schedule: createDefaultDueDateWorkItemSchedule('2026-06-03') }),
  ], baselineRow)

  await client.updateTeamIssueSchedules(
    'workspace-1',
    [
      { teamId: 'core-team', workItemId: 'wireframe', expectedRevision: 1, schedule: createDefaultDueDateWorkItemSchedule('2026-06-05') },
      { teamId: 'core-team', workItemId: 'review', expectedRevision: 1, schedule: createDefaultDueDateWorkItemSchedule('2026-06-05') },
    ],
    [],
    'demo@example.com',
    auditContext(),
  )

  expect(reads.baseline).toBe(1)
  const audits = (transactions[0]?.TransactItems ?? [])
    .flatMap((item) => item.Put?.TableName === 'AuditTable' ? [item.Put.Item] : [])
  expect(audits.map((audit) => Reflect.get(audit?.metadata ?? {}, 'baselineSlip'))).toEqual([
    { baselineRevision: 1, baselineEndDate: '2026-06-01', previousDelayDays: 2, delayDays: 4 },
    { baselineRevision: 1, baselineEndDate: '2026-06-03', previousDelayDays: 0, delayDays: 2 },
  ])
})

test('measures a reopened Work Item against the baseline again', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-05-25' }])
  const { client, transactions, reads } = createClient(storedIssue({
    workflowStatusId: 'done',
    statusCategory: 'completed',
    actualStartDate: '2026-05-20',
    actualEndDate: '2026-05-26',
  }), baselineRow)

  await client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { workflowSchemaVersion: 1, workflowStatusId: 'doing', statusCategory: 'started', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )

  expect(reads.baseline).toBe(1)
  expect(readAudit(transactions[0]).baselineSlip).toEqual({
    baselineRevision: 1,
    baselineEndDate: '2026-05-25',
    previousDelayDays: 1,
    delayDays: 9,
  })
})

test('fails the edit closed when the stored baseline row is corrupt', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-06-01' }])
  const { client, transactions } = createClient(storedIssue(), { ...baselineRow, schemaVersion: 999 })

  const error: unknown = await moveDeadline(client, '2026-06-20').then(() => undefined, (cause: unknown) => cause)

  expect(error).toMatchObject({ code: 'ScheduleBaselineCorruptState' })
  expect(transactions).toHaveLength(0)
})

test('commits the edit only while the active baseline it was measured against is unchanged', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-06-01' }])
  const measured = createClient(storedIssue(), baselineRow)
  await moveDeadline(measured.client, '2026-06-05')
  expect(readBaselineFence(measured.transactions[0])).toMatchObject({
    Key: { workspaceId: 'workspace-1', recordKey: 'PROJECT_SCHEDULE_BASELINE#core-team#launch' },
    ExpressionAttributeValues: { ':revision': 1 },
  })

  // A baseline captured after an empty read could include the item, so its absence is checked too.
  const empty = createClient(storedIssue())
  await moveDeadline(empty.client, '2026-06-05')
  expect(readBaselineFence(empty.transactions[0])?.ConditionExpression).toBe('attribute_not_exists(recordKey)')

  const titleOnly = createClient(storedIssue(), baselineRow)
  await titleOnly.client.updateTeamIssue(
    'workspace-1', 'core-team', 'wireframe',
    { title: 'Wireframe v2', expectedRevision: 1 },
    'demo@example.com', auditContext(),
  )
  expect(readBaselineFence(titleOnly.transactions[0])).toBeUndefined()

  const switched = createClient(storedIssue(), baselineRow, true)
  expect(await moveDeadline(switched.client, '2026-06-05').catch((error: unknown) => error))
    .toMatchObject({ status: 409, code: 'ScheduleBaselineChanged' })
})

test('checks each Project baseline once in a cascade and reports a switch as a conflict', async () => {
  const baselineRow = await storedBaselineRow([{ workItemId: 'wireframe', endDate: '2026-06-01' }])
  const stored = [
    storedIssue(),
    storedIssue({ issueId: 'review', title: 'Review' }),
  ]
  const updates = [
    { teamId: 'core-team', workItemId: 'wireframe', expectedRevision: 1, schedule: createDefaultDueDateWorkItemSchedule('2026-06-05') },
    { teamId: 'core-team', workItemId: 'review', expectedRevision: 1, schedule: createDefaultDueDateWorkItemSchedule('2026-06-05') },
  ]
  const cascade = createClient(stored, baselineRow)
  await cascade.client.updateTeamIssueSchedules('workspace-1', updates, [], 'demo@example.com', auditContext())
  expect(readBaselineFences(cascade.transactions[0])).toHaveLength(1)

  const switched = createClient(stored, baselineRow, true)
  expect(await switched.client.updateTeamIssueSchedules('workspace-1', updates, [], 'demo@example.com', auditContext())
    .catch((error: unknown) => error))
    .toMatchObject({ status: 409, code: 'ScheduleBaselineChanged' })
})
