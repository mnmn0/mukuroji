import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import type { StoredWeeklyReportSubmission, WeeklyReportWeekRecord } from '../../application/weekly-report-use-cases'
import { DynamoDbWeeklyReportStore } from './weekly-report-store'

/** Author shared by every test. */
const scope = { workspaceId: 'w', teamId: 't', memberKey: 'm@example.com' }

/** Caller fence included in every write. */
const callerAuthorization = [{ ConditionCheck: { TableName: 'access', Key: { k: 'v' }, ConditionExpression: 'attribute_exists(k)' } }]

/** Audit context of the writes. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'u', kind: 'user', displayName: 'U' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

/** Week record written by the tests. */
const week: WeeklyReportWeekRecord = {
  weekStart: '2026-11-16',
  revision: 1,
  updatedAt: '2026-11-20T00:00:00.000Z',
  notes: { issues: 'Blocked', reflection: 'Fine' },
  submissionCount: 1,
  lastSubmittedAt: '2026-11-20T00:00:00.000Z',
}

/** Submission written by the tests. */
const submission: StoredWeeklyReportSubmission = {
  version: 1,
  submittedAt: '2026-11-20T00:00:00.000Z',
  weekStart: '2026-11-16',
  weekEnd: '2026-11-22',
  sections: { completed: [{ workItemId: 'a', minutes: 30 }], started: [], overdue: [], upcoming: [] },
  time: [{ workItemId: 'a', minutes: 30 }],
  items: [{ workItemId: 'a', title: 'A', projectId: 'p' }],
  totalMinutes: 30,
  timeIsPartial: false,
  notes: { issues: 'Blocked', reflection: 'Fine' },
}

/** Commands the fake client received. */
type SentCommand = {
  /** Command class, identified by its name. */
  constructor: {
    /** Command class name, such as `TransactWriteCommand`. */
    name: string
  }
  /** Command input as sent to the client. */
  input: Record<string, unknown>
}

/**
 * Builds a document client that answers each command with the next canned response.
 *
 * @param responses - Responses by command name, used in order.
 * @param sent - List collecting every command.
 * @returns The fake client.
 */
function fakeClient(responses: Record<string, unknown[]>, sent: SentCommand[] = []): DynamoDBDocumentClient {
  const client = {
    async send(command: SentCommand) {
      sent.push(command)
      const queue = responses[command.constructor.name] ?? []
      const next = queue.shift()
      if (next instanceof Error) throw next
      return next ?? {}
    },
  }
  return Object.assign(Object.create(null), client)
}

/**
 * Builds the stored row of the test week.
 *
 * @param overrides - Fields to replace.
 * @returns The row.
 */
function weekRow(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'w',
    recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-16',
    entryType: 'weekly-report',
    schemaVersion: 1,
    teamId: 't',
    memberKey: 'm@example.com',
    ...week,
    ...overrides,
  }
}

/**
 * Builds a transaction cancellation with the given reason codes.
 *
 * @param codes - Cancellation reason codes.
 * @returns The error.
 */
function cancellation(codes: string[]) {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  })
}

test('writes the week, the new version, the caller fence, and the audit event in one transaction', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({}, sent), 'audit')
  await store.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission })
  const input = sent[0]?.input
  const items = Array.isArray(input?.TransactItems) ? input.TransactItems : []
  expect(items).toHaveLength(4)
  expect(items[0]).toMatchObject({
    Put: {
      TableName: 'planning',
      Item: { recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-16', entryType: 'weekly-report', submissionCount: 1 },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    },
  })
  expect(items[1]).toMatchObject({
    Put: {
      Item: { recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#S#2026-11-16#0001', entryType: 'weekly-report-submission', version: 1 },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    },
  })
  expect(items[2]).toEqual(callerAuthorization[0])
  // The audit event names the week and version but carries none of the report text.
  const audit = JSON.stringify(items[3])
  expect(audit).toContain('weekly_report_submitted')
  expect(audit).not.toContain('Blocked')
})

test('guards a replacement with the previous revision and submission count', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({}, sent))
  await store.saveDraft({
    ...scope,
    now: week.updatedAt,
    callerAuthorization,
    auditContext,
    previous: week,
    next: { ...week, revision: 2, notes: { issues: '', reflection: '' } },
  })
  const items = sent[0]?.input.TransactItems
  expect(Array.isArray(items) ? items[0] : undefined).toMatchObject({
    Put: { ExpressionAttributeValues: { ':type': 'weekly-report', ':revision': 1, ':submissionCount': 1 } },
  })
})

test('maps a failed condition to a conflict and throttling to a retryable failure', async () => {
  const conflict = new DynamoDbWeeklyReportStore('planning', fakeClient({
    TransactWriteCommand: [cancellation(['ConditionalCheckFailed', 'None', 'None'])],
  }))
  await expect(conflict.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission }))
    .rejects.toMatchObject({ status: 409, code: 'WeeklyReportConflict' })
  const throttled = new DynamoDbWeeklyReportStore('planning', fakeClient({
    TransactWriteCommand: [cancellation(['ThrottlingError', 'None', 'None'])],
  }))
  await expect(throttled.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission }))
    .rejects.toMatchObject({ status: 503 })
})

test('refuses a write without caller fences', async () => {
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({}))
  await expect(store.saveDraft({ ...scope, now: week.updatedAt, callerAuthorization: [], auditContext, previous: null, next: week }))
    .rejects.toMatchObject({ status: 503 })
})

test('reads a stored week and refuses a row of another member', async () => {
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    GetCommand: [{ Item: weekRow() }, { Item: weekRow({ memberKey: 'other@example.com' }) }],
  }))
  expect(await store.getWeek(scope, '2026-11-16')).toEqual(week)
  await expect(store.getWeek(scope, '2026-11-16')).rejects.toMatchObject({ status: 502, code: 'WeeklyReportCorruptState' })
})

test('reads a stored version and refuses one with an unknown section', async () => {
  const row = {
    workspaceId: 'w',
    recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#S#2026-11-16#0001',
    entryType: 'weekly-report-submission',
    schemaVersion: 1,
    teamId: 't',
    memberKey: 'm@example.com',
    ...submission,
  }
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    GetCommand: [{ Item: row }, { Item: { ...row, sections: { ...submission.sections, extra: [] } } }],
  }))
  expect(await store.getSubmission(scope, '2026-11-16', 1)).toEqual(submission)
  await expect(store.getSubmission(scope, '2026-11-16', 1)).rejects.toMatchObject({ status: 502 })
})

test('pages the history newest first and keeps reading until the page is full', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    QueryCommand: [
      { Items: [weekRow()], LastEvaluatedKey: { workspaceId: 'w', recordKey: 'k1' } },
      {
        Items: [weekRow({ recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-09', weekStart: '2026-11-09' })],
        LastEvaluatedKey: { workspaceId: 'w', recordKey: 'k2' },
      },
    ],
  }, sent))
  const page = await store.listWeeks(scope, { limit: 1, before: '2026-11-23', submittedOnly: true })
  expect(page).toEqual({ weeks: [week], hasMore: true })
  expect(sent[0]?.input).toMatchObject({
    ScanIndexForward: false,
    Limit: 2,
    FilterExpression: '#submissionCount > :zero',
    ExclusiveStartKey: { workspaceId: 'w', recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-23' },
  })
  expect(sent[1]?.input).toMatchObject({ Limit: 1, ExclusiveStartKey: { recordKey: 'k1' } })
})

test('reads several members\' weeks and retries unprocessed keys', async () => {
  const sent: SentCommand[] = []
  const other = { ...scope, memberKey: 'o@example.com' }
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    BatchGetCommand: [
      {
        Responses: { planning: [weekRow()] },
        UnprocessedKeys: { planning: { Keys: [{ workspaceId: 'w', recordKey: 'WEEKLY_REPORT#t#MEMBER#o%40example.com#W#2026-11-16' }] } },
      },
      { Responses: { planning: [] } },
    ],
  }, sent))
  const weeks = await store.getWeeks(scope, ['m@example.com', other.memberKey], '2026-11-16')
  expect([...weeks.entries()]).toEqual([['m@example.com', week]])
  expect(sent).toHaveLength(2)
})
