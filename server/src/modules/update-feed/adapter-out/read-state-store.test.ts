import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbUpdateFeedReadStateStore } from './read-state-store'

/** Builds a document client with an isolated command-level test boundary. */
function clientFor(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // The adapter is deliberately replaced at the SDK boundary; tests inspect every command.
  client.send = send as DynamoDBDocumentClient['send']
  return client
}

const report = { target: { type: 'project' as const, teamId: 'team', projectId: 'project' }, version: 1 }

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
  await expect(store.getMany('workspace', 'reader', [report])).rejects.toThrow('unavailable')
})

test('atomically guards Planning revision and member-state CAS without copying report content', async () => {
  let conflict = false
  const client = clientFor(async (command) => {
    expect(command).toBeInstanceOf(TransactWriteCommand)
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems
    expect(items).toHaveLength(2)
    expect(items?.[0]?.ConditionCheck).toMatchObject({ Key: { workspaceId: 'FENCE#workspace', recordKey: 'META' }, ExpressionAttributeValues: { ':revision': 7 } })
    expect(items?.[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(recordKey)', Item: { workspaceId: 'workspace', schemaVersion: 1, read: true, revision: 1 } })
    expect(Object.keys(items?.[1]?.Put?.Item ?? {}).sort()).toEqual(['read', 'recordKey', 'revision', 'schemaVersion', 'workspaceId'])
    if (conflict) throw Object.assign(new Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] })
    return {}
  })
  const store = new DynamoDbUpdateFeedReadStateStore('planning', client)
  expect(await store.set('workspace', 'reader', { ...report, read: true, expectedRevision: 0 }, 7)).toEqual({ read: true, revision: 1 })
  conflict = true
  await expect(store.set('workspace', 'reader', { ...report, read: true, expectedRevision: 0 }, 7)).rejects.toMatchObject({ status: 409 })
})
