import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbUpdateFeedReadStateStore } from './read-state-store'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'

/** Builds a document client with an isolated command-level test boundary. */
function clientFor(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // The adapter is deliberately replaced at the SDK boundary; tests inspect every command.
  client.send = send as DynamoDBDocumentClient['send']
  return client
}

const report = { target: { type: 'project' as const, teamId: 'team', projectId: 'project' }, version: 1 }
const callerChecks: PlanningCallerAuthorizationConditionCheck[] = [
  { ConditionCheck: { TableName: 'members', Key: { workspaceId: 'workspace', recordKey: 'MEMBER#reader' }, ConditionExpression: '#version = :version AND #status = :active', ExpressionAttributeNames: { '#version': 'version', '#status': 'status' }, ExpressionAttributeValues: { ':version': 3, ':active': 'active' } } },
  { ConditionCheck: { TableName: 'identity', Key: { scopeKey: 'WORKSPACE#workspace', recordKey: 'CONTROL' }, ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'controlRevision' }, ExpressionAttributeValues: { ':revision': 8 } } },
]

test('reads only exact bounded keys with strong consistency and rejects corrupt or failed reads', async () => {
  let reads = 0
  let corrupt = false
  let unavailable = false
  const client = clientFor(async (command) => {
    expect(command).toBeInstanceOf(GetCommand)
    if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
    reads++
    expect(command.input.ConsistentRead).toBe(true)
    expect(command.input.Key?.workspaceId).toBe('workspace')
    expect(String(command.input.Key?.recordKey)).toStartWith('UPDATE_FEED_READ#')
    expect(String(command.input.Key?.recordKey).length).toBeLessThan(1024)
    if (unavailable) throw new Error('unavailable')
    return { Item: { ...command.input.Key, schemaVersion: corrupt ? 2 : 1, read: true, revision: 1 } }
  })
  const store = new DynamoDbUpdateFeedReadStateStore('planning', client)
  expect((await store.getMany('workspace', 'reader', [report, report])).size).toBe(1)
  expect(reads).toBe(1)
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...report, version: i + 1 }))
  await expect(store.getMany('workspace', 'reader', tooMany)).rejects.toMatchObject({ status: 413 })
  expect(reads).toBe(1)
  corrupt = true
  await expect(store.getMany('workspace', 'reader', [report])).rejects.toMatchObject({ status: 502 })
  unavailable = true
  await expect(store.getMany('workspace', 'reader', [report])).rejects.toMatchObject({ status: 502, code: 'UpdateFeedReadStateStorageFailure' })
})

test('atomically guards Planning revision and member-state CAS without copying report content', async () => {
  let conflict = false
  const client = clientFor(async (command) => {
    expect(command).toBeInstanceOf(TransactWriteCommand)
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems
    expect(items).toHaveLength(4)
    expect(items?.slice(2)).toEqual(callerChecks)
    expect(items?.[0]?.ConditionCheck).toMatchObject({ Key: { workspaceId: 'FENCE#workspace', recordKey: 'META' },
      ConditionExpression: '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #revision = :revision',
      ExpressionAttributeNames: { '#entryType': 'entryType', '#schemaVersion': 'schemaVersion', '#revision': 'revision' },
      ExpressionAttributeValues: { ':entryType': 'planning-meta', ':schemaVersion': 1, ':revision': 7 } })
    expect(items?.[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: { workspaceId: 'workspace', schemaVersion: 1, read: true, revision: 1 } })
    expect(Object.keys(items?.[1]?.Put?.Item ?? {}).sort()).toEqual(['read', 'recordKey', 'revision', 'schemaVersion', 'workspaceId'])
    if (conflict) throw Object.assign(new Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' }] })
    return {}
  })
  const store = new DynamoDbUpdateFeedReadStateStore('planning', client).withCallerAuthorization(callerChecks)
  expect(await store.set('workspace', 'reader', { ...report, read: true, expectedRevision: 0 }, 7)).toEqual({ read: true, revision: 1 })
  conflict = true
  await expect(store.set('workspace', 'reader', { ...report, read: true, expectedRevision: 0 }, 7)).rejects.toMatchObject({ status: 409 })
})

test('requires caller guards and rejects membership or Enterprise revocation at commit time', async () => {
  let changedIndex = 2
  let commits = 0
  const client = clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    expect(command.input.TransactItems?.slice(2)).toEqual(callerChecks)
    if (changedIndex >= 0) throw Object.assign(new Error('revoked'), { name: 'TransactionCanceledException', CancellationReasons: command.input.TransactItems?.map((_, index) => ({ Code: index === changedIndex ? 'ConditionalCheckFailed' : 'None' })) })
    commits++
    return {}
  })
  const unbound = new DynamoDbUpdateFeedReadStateStore('planning', client)
  const input = { ...report, read: true, expectedRevision: 0 }
  await expect(unbound.set('workspace', 'reader', input, 7)).rejects.toMatchObject({ code: 'UpdateFeedAuthorizationUnavailable' })
  const store = unbound.withCallerAuthorization(callerChecks)
  for (const index of [0, 2, 3]) {
    changedIndex = index
    await expect(store.set('workspace', 'reader', input, 7)).rejects.toMatchObject({ code: 'UpdateFeedReadStateConflict' })
  }
  expect(commits).toBe(0)
  changedIndex = -1
  expect(await store.set('workspace', 'reader', input, 7)).toEqual({ read: true, revision: 1 })
  expect(commits).toBe(1)
})

test('distinguishes conditional-only, mixed transient, unknown and malformed transaction failures', async () => {
  for (const [codes, status, code] of [
    [['None', 'ConditionalCheckFailed'], 409, 'UpdateFeedReadStateConflict'],
    [['None', 'TransactionConflict'], 503, 'UpdateFeedReadStateRetryable'],
    [['ConditionalCheckFailed', 'ThrottlingError'], 503, 'UpdateFeedReadStateRetryable'],
    [['ProvisionedThroughputExceeded', 'None'], 503, 'UpdateFeedReadStateRetryable'],
    [['ConditionalCheckFailed', 'ValidationError'], 502, 'UpdateFeedReadStateStorageFailure'],
    [['ConditionalCheckFailed', undefined], 502, 'UpdateFeedReadStateStorageFailure'],
    [[], 502, 'UpdateFeedReadStateStorageFailure'],
  ] as const) {
    const reasons = codes.length ? [...codes, 'None', 'None'] : []
    const client = clientFor(async () => { throw Object.assign(new Error('private provider detail'), { name: 'TransactionCanceledException', CancellationReasons: reasons.map((Code) => ({ Code })) }) })
    const store = new DynamoDbUpdateFeedReadStateStore('planning', client).withCallerAuthorization(callerChecks)
    await expect(store.set('workspace', 'reader', { ...report, read: true, expectedRevision: 0 }, 7)).rejects.toMatchObject({ status, code })
  }
  const client = clientFor(async () => { throw Object.assign(new Error('private provider detail'), { name: 'ThrottlingException' }) })
  await expect(new DynamoDbUpdateFeedReadStateStore('planning', client).getMany('workspace', 'reader', [report])).rejects.toMatchObject({ status: 503, code: 'UpdateFeedReadStateRetryable' })
})
