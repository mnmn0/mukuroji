import { expect, test } from 'bun:test'
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../../../audit/audit'
import {
  DynamoDbCycleScheduleBaselineStore,
  InMemoryCycleScheduleBaselineStore,
} from './cycle-schedule-baseline-store'
import { PlanningError } from '../../planning'
import { captureCycleScheduleBaselineUseCase, readCycleScheduleBaselineUseCase } from '../../application/cycle-schedule-baseline'

/** Audit context of the test caller. */
const auditContext = createMutationAuditContext({
  workspaceId: 'ws',
  actor: { id: 'manager', kind: 'user' },
  occurredAt: '2026-11-22T00:00:00.000Z',
  idempotencyKey: 'cycle-baseline-test',
  request: { method: 'POST', path: '/api/planning/cycles/cycle-a/schedule-baselines', body: {} },
  source: { kind: 'api' },
})

/** Fence that stands in for the caller's authorization checks. */
const fence = { ConditionCheck: { TableName: 'members', Key: { id: 'manager' }, ConditionExpression: 'attribute_exists(id)' } }

test('reads keep only visible entries but count every entry', async () => {
  const store = new InMemoryCycleScheduleBaselineStore()
  const scope = { workspaceId: 'ws', cycleId: 'cycle-a' }
  await captureCycleScheduleBaselineUseCase(store, scope, {
    capturedAt: '2026-11-22T00:00:00.000Z',
    readEntries: async () => [
      { teamId: 'team-a', workItemId: 'visible', endDate: '2026-11-30' },
      { teamId: 'team-b', workItemId: 'hidden', endDate: '2026-12-01' },
    ],
    callerAuthorization: [fence],
    auditContext,
    createBaselineId: () => 'cb-1',
  })
  const read = await readCycleScheduleBaselineUseCase(store, scope, (entry) => entry.teamId === 'team-a')
  expect(read.baseline).toEqual({
    id: 'cb-1',
    capturedAt: '2026-11-22T00:00:00.000Z',
    entryCount: 2,
    entries: [{ teamId: 'team-a', workItemId: 'visible', endDate: '2026-11-30' }],
  })
})

test('refuses a Cycle larger than one baseline holds', async () => {
  const store = new InMemoryCycleScheduleBaselineStore()
  const entries = Array.from({ length: 1001 }, (_, index) => ({ teamId: 't', workItemId: `w${index}` }))
  const capture = captureCycleScheduleBaselineUseCase(store, { workspaceId: 'ws', cycleId: 'c' }, {
    capturedAt: '2026-11-22T00:00:00.000Z',
    readEntries: async () => entries,
    callerAuthorization: [fence],
    auditContext,
  })
  expect(capture).rejects.toMatchObject({ status: 413, code: 'CycleScheduleBaselineTooLarge' })
})

test('the DynamoDB store writes the list, the baseline, drops, fences, and audit in one transaction', async () => {
  const sent: unknown[] = []
  const client: Pick<DynamoDBDocumentClient, 'send'> = {
    send: async (command: unknown) => {
      sent.push(command)
      return {}
    },
  }
  const store = new DynamoDbCycleScheduleBaselineStore('planning', client, 'audit')
  await store.write({
    workspaceId: 'ws',
    cycleId: 'cycle-a',
    writtenAt: '2026-11-22T00:00:00.000Z',
    baseline: { id: 'cb-2', name: 'Start', capturedAt: '2026-11-22T00:00:00.000Z', entries: [{ teamId: 't', workItemId: 'w' }] },
    expectedRevision: 3,
    savedBaselines: [{ id: 'cb-2', name: 'Start', capturedAt: '2026-11-22T00:00:00.000Z', entryCount: 1 }],
    savedIdsToDelete: ['cb-old'],
    callerAuthorization: [fence],
    auditContext,
  })
  const command = sent[0]
  if (!(command instanceof TransactWriteCommand)) throw new Error('Expected one transaction.')
  const items = command.input.TransactItems ?? []
  expect(items).toHaveLength(5)
  expect(items[0]?.Put).toMatchObject({
    Item: { recordKey: 'CYCLE_SCHEDULE_BASELINE#cycle-a', entryType: 'cycle-schedule-baseline-index', revision: 4 },
    ConditionExpression: '#revision = :revision AND #type = :type',
    ExpressionAttributeValues: { ':revision': 3, ':type': 'cycle-schedule-baseline-index' },
  })
  expect(items[1]?.Put).toMatchObject({
    Item: { recordKey: 'CYCLE_SCHEDULE_BASELINE_SAVED#cycle-a#cb-2', entryType: 'cycle-schedule-baseline-saved', name: 'Start' },
    ConditionExpression: 'attribute_not_exists(recordKey)',
  })
  expect(items[2]?.Delete?.Key).toEqual({ workspaceId: 'ws', recordKey: 'CYCLE_SCHEDULE_BASELINE_SAVED#cycle-a#cb-old' })
  expect(items[3]).toEqual(fence)
  expect(items[4]?.Put?.TableName).toBe('audit')
  expect(JSON.stringify(items[4])).not.toContain('Start')
})

test('the DynamoDB store maps a failed condition to a conflict and refuses writes without fences', async () => {
  const client: Pick<DynamoDBDocumentClient, 'send'> = {
    send: async () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' }],
      })
    },
  }
  const store = new DynamoDbCycleScheduleBaselineStore('planning', client, 'audit')
  const input = {
    workspaceId: 'ws',
    cycleId: 'cycle-a',
    writtenAt: '2026-11-22T00:00:00.000Z',
    baseline: { id: 'cb-3', capturedAt: '2026-11-22T00:00:00.000Z', entries: [] },
    expectedRevision: 0,
    savedBaselines: [{ id: 'cb-3', capturedAt: '2026-11-22T00:00:00.000Z', entryCount: 0 }],
    savedIdsToDelete: [],
    callerAuthorization: [fence],
    auditContext,
  }
  const conflict = await store.write(input).catch((error: unknown) => error)
  expect(conflict).toBeInstanceOf(PlanningError)
  expect(conflict).toMatchObject({ status: 409, code: 'CycleScheduleBaselineConflict' })
  expect(store.write({ ...input, callerAuthorization: [] })).rejects.toMatchObject({ status: 503 })
})
