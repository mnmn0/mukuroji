import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { emptyDigestState } from '../application/digest'
import { DynamoDbUpdateFeedDigestStore } from './digest-store'

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
  for (mode of ['schema', 'identity', 'receipt', 'preferences']) await expect(store.get('w', 'reader')).rejects.toMatchObject({ status: 502 })
  mode = 'missing'
  expect(await store.get('w', 'reader')).toEqual(emptyDigestState())
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
