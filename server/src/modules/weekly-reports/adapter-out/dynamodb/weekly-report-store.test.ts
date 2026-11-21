import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, test } from 'bun:test'
import { WEEKLY_REPORT_MAX_MINUTES } from '@mukuroji/contracts'
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
  indirectTime: [{ category: 'meeting', minutes: 45 }],
  items: [{ workItemId: 'a', title: 'A', projectId: 'p' }],
  totalMinutes: 30,
  timeIsPartial: false,
  notes: { issues: 'Blocked', reflection: 'Fine' },
}

/** Receipt of the test submission request. */
const receipt = { key: 'request-hash', receipt: 'content-hash' }

/** Workspace Audit pseudonym key used when audit is on. */
const pseudonymKey = 'a'.repeat(64)

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
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({}, sent), 'audit', pseudonymKey)
  await store.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission, receipt })
  const input = sent[0]?.input
  const items = Array.isArray(input?.TransactItems) ? input.TransactItems : []
  expect(items).toHaveLength(5)
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
  expect(items[2]).toMatchObject({
    Put: {
      Item: {
        recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#R#request-hash',
        entryType: 'weekly-report-submission-receipt',
        receipt: 'content-hash',
        weekStart: '2026-11-16',
        version: 1,
      },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    },
  })
  expect(items[3]).toEqual(callerAuthorization[0])
  // The audit event names the week and version but carries none of the report text or the member key.
  const audit = JSON.stringify(items[4])
  expect(audit).toContain('weekly_report_submitted')
  expect(audit).toContain('/weekly-report/2026-11-16/1')
  expect(audit).not.toContain('Blocked')
  expect(audit).not.toContain('m@example.com')
  expect(audit).not.toContain('m%40example.com')
})

test('refuses an audited write when the Audit pseudonym key is missing', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({}, sent), 'audit')
  await expect(store.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission, receipt }))
    .rejects.toMatchObject({ status: 503, code: 'WeeklyReportAuditUnavailable' })
  expect(sent).toHaveLength(0)
})

test('reads a stored submission receipt and refuses one of another member', async () => {
  const row = {
    workspaceId: 'w',
    recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#R#request-hash',
    entryType: 'weekly-report-submission-receipt',
    schemaVersion: 1,
    teamId: 't',
    memberKey: 'm@example.com',
    receipt: 'content-hash',
    weekStart: '2026-11-16',
    version: 2,
  }
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    GetCommand: [{ Item: row }, {}, { Item: { ...row, memberKey: 'other@example.com' } }],
  }, sent))
  expect(await store.getSubmissionReceipt(scope, 'request-hash')).toEqual({ receipt: 'content-hash', weekStart: '2026-11-16', version: 2 })
  expect(sent[0]?.input).toMatchObject({ ConsistentRead: true, Key: { recordKey: row.recordKey } })
  expect(await store.getSubmissionReceipt(scope, 'request-hash')).toBeNull()
  await expect(store.getSubmissionReceipt(scope, 'request-hash')).rejects.toMatchObject({ status: 502 })
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
    TransactWriteCommand: [cancellation(['None', 'None', 'ConditionalCheckFailed', 'None'])],
  }))
  await expect(conflict.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission, receipt }))
    .rejects.toMatchObject({ status: 409, code: 'WeeklyReportConflict' })
  const throttled = new DynamoDbWeeklyReportStore('planning', fakeClient({
    TransactWriteCommand: [cancellation(['ThrottlingError', 'None', 'None', 'None'])],
  }))
  await expect(throttled.submit({ ...scope, now: week.updatedAt, callerAuthorization, auditContext, previous: null, next: week, submission, receipt }))
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
  const { indirectTime: _indirectTime, ...legacyRow } = row
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    GetCommand: [
      { Item: row },
      { Item: { ...row, sections: { ...submission.sections, extra: [] } } },
      { Item: { ...row, totalMinutes: WEEKLY_REPORT_MAX_MINUTES + 1 } },
      { Item: legacyRow },
      { Item: { ...row, indirectTime: [{ category: 'lunch', minutes: 30 }] } },
    ],
  }))
  expect(await store.getSubmission(scope, '2026-11-16', 1)).toEqual(submission)
  await expect(store.getSubmission(scope, '2026-11-16', 1)).rejects.toMatchObject({ status: 502 })
  await expect(store.getSubmission(scope, '2026-11-16', 1)).rejects.toMatchObject({ status: 502 })
  // A version submitted before indirect work was reported reads as having none.
  expect(await store.getSubmission(scope, '2026-11-16', 1)).toEqual({ ...submission, indirectTime: [] })
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
    ExclusiveStartKey: { workspaceId: 'w', recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-23' },
  })
  expect(sent[1]?.input).toMatchObject({ Limit: 1, ExclusiveStartKey: { recordKey: 'k1' } })
})

test('skips weeks never submitted only after validating them, so a malformed row fails the history', async () => {
  const draftOnly = weekRow({
    recordKey: 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-09',
    weekStart: '2026-11-09',
    submissionCount: 0,
    lastSubmittedAt: undefined,
  })
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    QueryCommand: [
      { Items: [weekRow(), draftOnly] },
      { Items: [weekRow({ submissionCount: 'many' })] },
    ],
  }))
  expect(await store.listWeeks(scope, { limit: 5, submittedOnly: true })).toEqual({ weeks: [week], hasMore: false })
  await expect(store.listWeeks(scope, { limit: 5, submittedOnly: true })).rejects.toMatchObject({ status: 502 })
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
      {
        Responses: {
          planning: [weekRow({ recordKey: 'WEEKLY_REPORT#t#MEMBER#o%40example.com#W#2026-11-16', memberKey: other.memberKey })],
        },
      },
    ],
  }, sent))
  const weeks = await store.getWeeks(scope, ['m@example.com', other.memberKey], '2026-11-16')
  expect([...weeks.entries()]).toEqual([['m@example.com', week], [other.memberKey, week]])
  expect(sent).toHaveLength(2)
  // Only the unprocessed key is sent again.
  expect(sent[1]?.input).toEqual({
    RequestItems: {
      planning: {
        Keys: [{ workspaceId: 'w', recordKey: 'WEEKLY_REPORT#t#MEMBER#o%40example.com#W#2026-11-16' }],
        ConsistentRead: true,
      },
    },
  })
})

test('lists the submitted weeks that start within a range, following pages', async () => {
  const sent: SentCommand[] = []
  const store = new DynamoDbWeeklyReportStore('planning', fakeClient({
    QueryCommand: [
      { Items: [], LastEvaluatedKey: { workspaceId: 'w', recordKey: 'k1' } },
      { Items: [weekRow()] },
    ],
  }, sent))
  expect(await store.listSubmittedWeeksBetween(scope, '2026-11-09', '2026-11-21')).toEqual([week])
  expect(sent[0]?.input).toMatchObject({
    KeyConditionExpression: '#workspaceId = :workspaceId AND #recordKey BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':from': 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-09',
      ':to': 'WEEKLY_REPORT#t#MEMBER#m%40example.com#W#2026-11-21',
    },
  })
  expect(sent[1]?.input).toMatchObject({ ExclusiveStartKey: { recordKey: 'k1' } })
})
