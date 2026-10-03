import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { emptyDigestState, previewUpdateFeedDigest } from '../application/digest'
import { DynamoDbUpdateFeedDigestStore } from './digest-store'
import { InMemoryPlanningClient } from '../../planning/planning'
import { InMemoryUpdateFeedReadStateStore } from './read-state-store'

/** Replaces only the overloaded SDK transport to inspect real command inputs. */
function clientFor(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // SDK overload replacement is isolated to this fake; command inputs are asserted below.
  client.send = send as DynamoDBDocumentClient['send']
  return client
}
const checks: PlanningCallerAuthorizationConditionCheck[] = [{ ConditionCheck: { TableName: 'members', Key: { workspaceId: 'w', recordKey: 'MEMBER#reader' }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 2 } } }]

test('reads one strongly consistent scoped row and fails closed on malformed persisted state', async () => {
  let mode = 'valid'
  const keys: unknown[] = []
  const store = new DynamoDbUpdateFeedDigestStore('planning', clientFor(async (command) => {
    if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
    expect(command.input.ConsistentRead).toBe(true)
    expect(command.input.Key?.workspaceId).toBe('w')
    expect(String(command.input.Key?.recordKey)).toStartWith('UPDATE_FEED_DIGEST#')
    keys.push(command.input.Key)
    if (mode === 'missing') return {}
    return { Item: { ...command.input.Key, ...emptyDigestState(), revision: 1, entryType: 'update-feed-digest', schemaVersion: mode === 'schema' ? 9 : 1, ...(mode === 'identity' ? { workspaceId: 'other' } : {}), ...(mode === 'receipt' ? { history: [{ id: 'bad' }] } : {}), ...(mode === 'preferences' ? { preferences: {} } : {}) } }
  }))
  expect(await store.get('w', ' Reader ')).toEqual({ ...emptyDigestState(), revision: 1 })
  await store.get('w', 'reader')
  expect(keys[0]).toEqual(keys[1])
  for (mode of ['schema', 'identity', 'receipt', 'preferences']) await expect(store.get('w', 'reader')).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState' })
  mode = 'missing'
  expect(await store.get('w', 'reader')).toEqual(emptyDigestState())
})

test('SDK reads and writes distinguish permanent, transient and unknown failures without exposing details', async () => {
  for (const [name, status, code] of [
    ['ValidationException', 502, 'UpdateFeedDigestStoragePermanent'],
    ['AccessDeniedException', 502, 'UpdateFeedDigestStoragePermanent'],
    ['ResourceNotFoundException', 502, 'UpdateFeedDigestStoragePermanent'],
    ['TimeoutError', 503, 'UpdateFeedDigestRetryable'],
    ['ThrottlingException', 503, 'UpdateFeedDigestRetryable'],
    ['Error', 502, 'UpdateFeedDigestStorageFailure'],
    ['NetworkingError', 502, 'UpdateFeedDigestStorageFailure'],
  ] as const) {
    const store = new DynamoDbUpdateFeedDigestStore('planning', clientFor(async () => { throw Object.assign(new Error('private SDK detail'), { name }) }), checks)
    for (const operation of [() => store.get('w', 'reader'), () => store.replace('w', 'reader', emptyDigestState())]) {
      try { await operation(); throw new Error('Expected failure') }
      catch (error) { expect(error).toMatchObject({ status, code }); expect(String(error)).not.toContain('private SDK') }
    }
  }
})

test('malformed cancellation evidence stays unknown and proven permanent reasons outrank transient ones', async () => {
  for (const [codes, code] of [
    [['ValidationError', 'ThrottlingError'], 'UpdateFeedDigestStoragePermanent'],
    [['None', 'ItemCollectionSizeLimitExceeded'], 'UpdateFeedDigestStoragePermanent'],
    [['None', 'ThrottlingError'], 'UpdateFeedDigestRetryable'],
    [['None', 'UnknownReason'], 'UpdateFeedDigestStorageFailure'],
    [['ValidationError'], 'UpdateFeedDigestStorageFailure'],
    [['None', 'None'], 'UpdateFeedDigestStorageFailure'],
  ] as const) {
    const store = new DynamoDbUpdateFeedDigestStore('planning', clientFor(async () => { throw { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) } }), checks)
    await expect(store.replace('w', 'reader', emptyDigestState())).rejects.toMatchObject({ code })
  }
})

test('atomically guards receipt CAS, caller revocation and Planning authorization fence', async () => {
  let codes: string[] | undefined
  const unbound = new DynamoDbUpdateFeedDigestStore('planning', clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems
    expect(items).toHaveLength(3)
    expect(items?.[1]).toEqual(checks[0])
    expect(items?.[2]?.ConditionCheck).toMatchObject({ Key: { workspaceId: 'FENCE#w', recordKey: 'META' }, ExpressionAttributeValues: { ':revision': 7, ':schemaVersion': 1, ':entryType': 'planning-meta' } })
    expect(items?.[0]?.Put).toMatchObject({ ConditionExpression: '#revision = :revision AND #schema = :schema AND #type = :type', Item: { workspaceId: 'w', schemaVersion: 1, revision: 2 } })
    expect(Object.keys(items?.[0]?.Put?.Item ?? {}).sort()).toEqual(['entryType', 'history', 'preferences', 'recordKey', 'revision', 'schemaVersion', 'workspaceId'])
    if (codes) throw Object.assign(new Error('private storage detail'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) })
    return {}
  }))
  const input = { ...emptyDigestState(), revision: 1 }
  await expect(unbound.replace('w', 'reader', input, 7)).rejects.toMatchObject({ status: 503 })
  const bound = unbound.withCallerAuthorization(checks)
  expect(await bound.replace('w', 'reader', input, 7)).toEqual({ ...input, revision: 2 })
  for (codes of [['ConditionalCheckFailed', 'None', 'None'], ['None', 'ConditionalCheckFailed', 'None'], ['None', 'None', 'ConditionalCheckFailed']]) await expect(bound.replace('w', 'reader', input, 7)).rejects.toMatchObject({ status: 409 })
  codes = ['ConditionalCheckFailed', 'ThrottlingError', 'None']
  await expect(bound.replace('w', 'reader', input, 7)).rejects.toMatchObject({ status: 503 })
  codes = ['ConditionalCheckFailed']
  await expect(bound.replace('w', 'reader', input, 7)).rejects.toMatchObject({ status: 502 })
})

/** Executes observed SDK conditions against isolated durable rows, with no live AWS.
 * @returns A caller-bound adapter and controls for concurrent Planning writes.
 */
function durableFixture() {
  let row: Record<string, unknown> | undefined
  let meta: Record<string, unknown> | undefined
  const store = new DynamoDbUpdateFeedDigestStore('planning', clientFor(async (command) => {
    if (command instanceof GetCommand) return { Item: row === undefined ? undefined : structuredClone(row) }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems ?? []
    const put = items[0]?.Put
    if (!put?.Item) throw new Error('Missing digest write')
    const expected = put.ExpressionAttributeValues?.[':revision']
    const cas = expected === undefined ? row === undefined : row?.revision === expected
    const fence = items[2]?.ConditionCheck
    let authorized = true
    if (fence) {
      expect(fence.Key).toEqual({ workspaceId: 'FENCE#w', recordKey: 'META' })
      if (fence.ConditionExpression === 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)') {
        expect(fence.ExpressionAttributeNames).toBeUndefined()
        expect(fence.ExpressionAttributeValues).toBeUndefined()
        authorized = meta === undefined
      } else {
        expect(fence.ConditionExpression).toBe('#entryType = :entryType AND #schemaVersion = :schemaVersion AND #revision = :revision')
        authorized = meta?.entryType === 'planning-meta' && meta?.schemaVersion === 1 && meta?.revision === fence.ExpressionAttributeValues?.[':revision']
      }
    }
    if (!cas || !authorized) throw Object.assign(new Error('Condition failed'), { name: 'TransactionCanceledException', CancellationReasons: items.map((_, index) => ({ Code: (index === 0 && !cas) || (index === 2 && !authorized) ? 'ConditionalCheckFailed' : 'None' })) })
    row = structuredClone(put.Item)
    return {}
  })).withCallerAuthorization(checks)
  return {
    store,
    /** Simulates a concurrent canonical Planning transaction at the condition boundary. */
    setMeta(value: Record<string, unknown> | undefined) { meta = value },
    /** Inspects persisted metadata without materializing report bodies. */
    readRow() { return structuredClone(row) },
  }
}

test('an untouched Workspace completes and replays empty previews without consuming its retry budget', async () => {
  const f = durableFixture()
  const snapshot = await new InMemoryPlanningClient().get('w', { workItems: [] })
  expect(snapshot.revision).toBe(0)
  const reader = { memberKey: 'reader', readSnapshot: async () => snapshot, authorizeTarget: async () => undefined }
  await f.store.replace('w', 'reader', { ...emptyDigestState(), preferences: { enabled: true, frequency: 'daily', views: ['recent'] } })
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await previewUpdateFeedDigest(reader, new InMemoryUpdateFeedReadStateStore(), f.store, 'w', Date.parse('2026-10-03T12:00:00Z'))
    expect(result).toMatchObject({ replay: attempt > 0, entries: [], transport: 'preview' })
  }
  expect((await f.store.get('w', 'reader')).history).toMatchObject([{ status: 'completed', attempts: 1, count: 0 }])
})

test('concurrent first Planning write rejects revision zero and permits a fresh authorized retry', async () => {
  const f = durableFixture()
  const snapshot = await new InMemoryPlanningClient().get('w', { workItems: [] })
  await f.store.replace('w', 'reader', { ...emptyDigestState(), preferences: { enabled: true, frequency: 'daily', views: ['recent'] } })
  let reads = 0
  const reader = { memberKey: 'reader', readSnapshot: async () => {
    if (++reads === 2) f.setMeta({ workspaceId: 'FENCE#w', recordKey: 'META', entryType: 'planning-meta', schemaVersion: 1, revision: 1 })
    return snapshot
  }, authorizeTarget: async () => undefined }
  await expect(previewUpdateFeedDigest(reader, new InMemoryUpdateFeedReadStateStore(), f.store, 'w', Date.parse('2026-10-03T12:00:00Z'))).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ status: 'failed', attempts: 1 })
  snapshot.revision = 1
  await previewUpdateFeedDigest(reader, new InMemoryUpdateFeedReadStateStore(), f.store, 'w', Date.parse('2026-10-03T12:00:00Z'))
  expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ status: 'completed', attempts: 2 })
})

test('zero requires an absent META row while positive revisions retain typed exact equality', async () => {
  const f = durableFixture()
  for (const meta of [
    { workspaceId: 'FENCE#w', recordKey: 'META', entryType: 'planning-meta', schemaVersion: 1, revision: 0 },
    { workspaceId: 'FENCE#w', recordKey: 'META', entryType: 'planning-meta', schemaVersion: 1, revision: 1 },
    { workspaceId: 'FENCE#w', recordKey: 'META', entryType: 'malformed' },
  ]) {
    f.setMeta(meta)
    await expect(f.store.replace('w', 'reader', emptyDigestState(), 0)).rejects.toMatchObject({ status: 409 })
    expect(f.readRow()).toBeUndefined()
  }
  for (const meta of [undefined, { entryType: 'planning-meta', schemaVersion: 1, revision: 8 }, { entryType: 'planning-meta', schemaVersion: 9, revision: 7 }, { entryType: 'wrong', schemaVersion: 1, revision: 7 }]) {
    f.setMeta(meta)
    await expect(f.store.replace('w', 'reader', emptyDigestState(), 7)).rejects.toMatchObject({ status: 409 })
  }
  f.setMeta({ entryType: 'planning-meta', schemaVersion: 1, revision: 7 })
  expect(await f.store.replace('w', 'reader', emptyDigestState(), 7)).toMatchObject({ revision: 1 })
})
