import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { PlanningUpdateTarget } from '@mukuroji/contracts'
import { DynamoDbPlanningClient, InMemoryPlanningClient } from './planning'
import { advancePlanningUpdateActivity, readPlanningUpdateActivity } from './planning-update-activity'

const now = '2026-08-15T00:00:00.000Z'
const target: PlanningUpdateTarget = { type: 'project', teamId: 'team', projectId: 'project' }
const key = 'UPDATE_ACTIVITY#PROJECT#team#project'
/** Generates authentic canonical summary/context fixtures through the existing publication path. */
async function fixture() {
  const memory = new InMemoryPlanningClient(() => new Date(now))
  await memory.configureUpdateCadence('workspace', { target, expectedRevision: 0, cadence: { updateOwnerMemberKey: 'owner', cadence: { unit: 'week', count: 1 }, timeZone: 'UTC', nextDueAt: now, reminderHoursBefore: 24 } }, { workItems: [] })
  const published = await memory.publishUpdate('workspace', { target, expectedRevision: 1, id: 'report', health: 'on-track', risk: 'none', summary: 'Canonical report', riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '', evidence: [] }, 'author', { workItems: [] })
  return { memory, source: { workspaceId: 'workspace', recordKey: 'UPDATE_TARGET#PROJECT#team#project', entryType: 'planning-update-target', ...published.planning.updateTargets[0], latestContextSnapshot: published.update.contextSnapshot } }
}
/** Isolates SDK requests without real AWS access. */
function client(send: (command: unknown) => Promise<unknown>) {
  const lowLevel = new DynamoDBClient({ region: 'test' })
  const document = DynamoDBDocumentClient.from(lowLevel)
  // SDK overloaded transport is replaced only in this stub; commands are narrowed below.
  document.send = send as DynamoDBDocumentClient['send']
  return new DynamoDbPlanningClient('planning', document, lowLevel, false, () => new Date(now))
}

test('bounds recent participants, preserves monotonic times and resets signals for a new version', () => {
  let activity = advancePlanningUpdateActivity(undefined, target, 1, 'comment', ' First ', now)
  for (let i = 0; i < 40; i++) activity = advancePlanningUpdateActivity(activity, target, 1, 'reaction', `member-${i}`, new Date(Date.parse(now) + i * 1000).toISOString())
  expect(activity.participants).toHaveLength(32)
  expect(activity.participants.some((item) => item.memberKey === 'first')).toBe(false)
  const later = activity.reactionAt
  if (!later) throw new Error('Missing reaction fixture')
  activity = advancePlanningUpdateActivity(activity, target, 1, 'reaction', 'member-39', now)
  expect(activity.reactionAt).toBe(later)
  expect(activity.participants[0]?.at).toBe(later)
  const next = advancePlanningUpdateActivity(activity, target, 2, 'comment', 'reader', now)
  expect(next).toMatchObject({ version: 2, revision: activity.revision + 1, participants: [{ memberKey: 'reader', at: now }] })
  expect(next.reactionAt).toBeUndefined()
  expect(readPlanningUpdateActivity({ ...next, participants: [...next.participants, ...next.participants] })).toBeUndefined()
})

test('memory annotations update compact activity without changing canonical report or graph revision', async () => {
  const { memory } = await fixture()
  const before = await memory.get('workspace', { workItems: [] })
  await memory.createUpdateComment('workspace', { target, updateVersion: 1, id: 'comment', body: 'Private text' }, 'Reader')
  await memory.addUpdateReaction('workspace', { target, updateVersion: 1, emoji: '👍' }, 'reader')
  await memory.removeUpdateReaction('workspace', { target, updateVersion: 1, emoji: '👍' }, 'reader')
  expect(await memory.get('workspace', { workItems: [] })).toEqual(before)
  const activities = await memory.getUpdateActivities('workspace')
  expect(activities).toMatchObject([{ version: 1, revision: 2, commentAt: now, reactionAt: now, participants: [{ memberKey: 'reader', at: now }] }])
  expect(JSON.stringify(activities)).not.toContain('Private text')
  expect(await memory.getUpdateActivities('other')).toEqual([])
})

test('commits annotation, latest pointer fence, activity CAS and receipt atomically', async () => {
  const { source } = await fixture()
  let writes: TransactWriteCommandInput['TransactItems']
  const store = client(async (command) => {
    if (command instanceof GetCommand) { expect(command.input.ConsistentRead).toBe(true); return command.input.Key?.recordKey === source.recordKey ? { Item: source } : {} }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected history or scan read')
    writes = command.input.TransactItems
    return {}
  })
  await store.createUpdateComment('workspace', { target, updateVersion: 1, id: 'comment', body: 'Body stays canonical' }, 'reader', { prepare: async () => ({ transactWriteItem: { Put: { TableName: 'receipts', Item: { id: 'receipt' } } } }) })
  expect(writes).toHaveLength(6)
  expect(writes?.[3]?.ConditionCheck).toMatchObject({ Key: { recordKey: source.recordKey }, ExpressionAttributeValues: { ':version': 1 } })
  expect(writes?.[4]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: { recordKey: key, revision: 1, version: 1, commentAt: now } })
  expect(writes?.[4]?.Put?.Item).not.toHaveProperty('body')
  expect(writes?.[5]?.Put?.TableName).toBe('receipts')
})

test('rejects activity/new-version races and preserves retryable mixed failures', async () => {
  const { source } = await fixture()
  const activity = advancePlanningUpdateActivity(undefined, target, 1, 'comment', 'old-reader', now)
  let failed = 4
  let transient = false
  const store = client(async (command) => {
    if (command instanceof GetCommand) return { Item: command.input.Key?.recordKey === source.recordKey ? source : { workspaceId: 'workspace', recordKey: key, entryType: 'planning-update-activity', schemaVersion: 1, ...activity } }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    expect(command.input.TransactItems?.[4]?.Put?.ExpressionAttributeValues?.[':revision']).toBe(1)
    expect(command.input.TransactItems?.[4]?.Put?.Item?.participants).toHaveLength(2)
    throw Object.assign(new Error('storage failure'), { name: 'TransactionCanceledException', CancellationReasons: command.input.TransactItems?.map((_, index) => ({ Code: index === failed ? 'ConditionalCheckFailed' : transient && index === 0 ? 'ThrottlingError' : 'None' })) })
  })
  const input = { target, updateVersion: 1, id: 'comment', body: 'Body' }
  await expect(store.createUpdateComment('workspace', input, 'reader')).rejects.toMatchObject({ status: 409, code: 'PlanningUpdateActivityConflict' })
  failed = 3
  await expect(store.createUpdateComment('workspace', input, 'reader')).rejects.toMatchObject({ status: 409, code: 'PlanningUpdateActivityConflict' })
  transient = true
  await expect(store.createUpdateComment('workspace', input, 'reader')).rejects.toMatchObject({ status: 503 })
})

test('reads only the compact prefix with pagination and fails closed on corrupt rows or duplicate pages', async () => {
  const activity = advancePlanningUpdateActivity(undefined, target, 1, 'comment', 'reader', now)
  let duplicate = false
  let corrupt = false
  const store = client(async (command) => {
    if (!(command instanceof QueryCommand)) throw new Error('Unexpected history read')
    expect(command.input.ExpressionAttributeValues?.[':prefix']).toBe('UPDATE_ACTIVITY#')
    expect(command.input.ConsistentRead).toBe(true)
    if (command.input.ExclusiveStartKey && !duplicate) return { Items: [] }
    return { Items: [{ workspaceId: 'workspace', recordKey: key, entryType: 'planning-update-activity', schemaVersion: corrupt ? 9 : 1, ...activity }], LastEvaluatedKey: { workspaceId: 'workspace', recordKey: key } }
  })
  expect(await store.getUpdateActivities('workspace')).toEqual([activity])
  duplicate = true
  await expect(store.getUpdateActivities('workspace')).rejects.toMatchObject({ code: 'InvalidPlanningData' })
  corrupt = true
  await expect(store.getUpdateActivities('workspace')).rejects.toMatchObject({ code: 'InvalidPlanningData' })
})

test('parallel annotations race on activity CAS and an explicit retry preserves both participants', async () => {
  const { source } = await fixture()
  let stored: Record<string, unknown> | undefined
  let annotations = 0
  const store = client(async (command) => {
    if (command instanceof GetCommand) return { Item: command.input.Key?.recordKey === source.recordKey ? source : stored && structuredClone(stored) }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems ?? []
    const activity = items[4]?.Put
    if (!activity) throw new Error('Missing atomic activity write')
    const expected = activity.ExpressionAttributeValues?.[':revision'] ?? 0
    if ((stored?.revision ?? 0) !== expected) throw Object.assign(new Error('Concurrent annotation'), { name: 'TransactionCanceledException', CancellationReasons: items.map((_, index) => ({ Code: index === 4 ? 'ConditionalCheckFailed' : 'None' })) })
    stored = structuredClone(activity.Item)
    annotations++
    return {}
  })
  const input = { target, updateVersion: 1, body: 'Canonical annotation' }
  const outcomes = await Promise.allSettled([store.createUpdateComment('workspace', { ...input, id: 'one' }, 'one'), store.createUpdateComment('workspace', { ...input, id: 'two' }, 'two')])
  expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(annotations).toBe(1)
  const failed = outcomes[0]?.status === 'rejected' ? 'one' : 'two'
  await store.createUpdateComment('workspace', { ...input, id: failed }, failed)
  expect(annotations).toBe(2)
  expect(stored?.revision).toBe(2)
  expect(readPlanningUpdateActivity(stored)?.participants.map((item) => item.memberKey).sort()).toEqual(['one', 'two'])
})

test('historical or archived sources do not overwrite current activity', async () => {
  const { source } = await fixture()
  for (const current of [{ ...source, latestVersion: 2, latestUpdate: { ...source.latestUpdate, version: 2 } }, { ...source, archivedAt: now }]) {
    let reads = 0
    const store = client(async (command) => {
      if (command instanceof GetCommand) { reads++; return { Item: current } }
      if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
      expect(command.input.TransactItems).toHaveLength(3)
      expect(JSON.stringify(command.input)).not.toContain('UPDATE_ACTIVITY#')
      return {}
    })
    await store.createUpdateComment('workspace', { target, updateVersion: 1, id: 'historical', body: 'Historical annotation' }, 'reader')
    expect(reads).toBe(1)
  }
})

test('caps activity pages and bytes without returning a partial feed', async () => {
  let calls = 0
  let oversized = false
  const store = client(async (command) => {
    if (!(command instanceof QueryCommand)) throw new Error('Unexpected command')
    calls++
    const nextTarget: PlanningUpdateTarget = { type: 'initiative', entityId: `initiative-${calls}` }
    const recordKey = `UPDATE_ACTIVITY#INITIATIVE#initiative-${calls}`
    return { Items: [{ workspaceId: 'workspace', recordKey, entryType: 'planning-update-activity', schemaVersion: 1, ...advancePlanningUpdateActivity(undefined, nextTarget, 1, 'comment', 'reader', now), ...(oversized ? { unexpectedPayload: 'x'.repeat(4 * 1024 * 1024) } : {}) }], LastEvaluatedKey: { workspaceId: 'workspace', recordKey } }
  })
  await expect(store.getUpdateActivities('workspace')).rejects.toMatchObject({ code: 'PlanningActivityLimitExceeded' })
  expect(calls).toBe(20)
  calls = 0
  oversized = true
  await expect(store.getUpdateActivities('workspace')).rejects.toMatchObject({ code: 'PlanningActivityLimitExceeded' })
  expect(calls).toBe(1)
})

test('reaction activity preserves authorization and receipt indices and rejects incomplete cancellations', async () => {
  const { source } = await fixture()
  let failedIndex = 1
  let incomplete = false
  const store = client(async (command) => {
    if (command instanceof GetCommand) return command.input.Key?.recordKey === source.recordKey ? { Item: source } : {}
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems ?? []
    expect(items).toHaveLength(6)
    expect(items[1]?.ConditionCheck?.TableName).toBe('membership')
    expect(items[4]?.Put?.Item?.reactionAt).toBe(now)
    expect(items[5]?.Put?.TableName).toBe('receipts')
    const reasons = items.map((_, index) => ({ Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None' }))
    throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException', CancellationReasons: incomplete ? reasons.slice(0, 2) : reasons })
  })
  const hooks = { prepare: async () => ({ transactWriteItem: { Put: { TableName: 'receipts', Item: { id: 'receipt' } } } }), authorizationConditionChecks: [{ ConditionCheck: { TableName: 'membership', Key: { id: 'reader' }, ConditionExpression: 'attribute_exists(id)' } }] }
  const input = { target, updateVersion: 1, emoji: '👍' }
  await expect(store.addUpdateReaction('workspace', input, 'reader', hooks, hooks.authorizationConditionChecks)).rejects.toMatchObject({ code: 'PlanningAuthorizationChanged' })
  failedIndex = 5
  await expect(store.addUpdateReaction('workspace', input, 'reader', hooks, hooks.authorizationConditionChecks)).rejects.toMatchObject({ code: 'PlanningIdempotencyConflict' })
  failedIndex = 1
  incomplete = true
  await expect(store.addUpdateReaction('workspace', input, 'reader', hooks, hooks.authorizationConditionChecks)).rejects.toMatchObject({ status: 503 })
})
