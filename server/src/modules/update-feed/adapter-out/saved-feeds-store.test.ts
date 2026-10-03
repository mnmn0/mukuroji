import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { SavedUpdateFeed } from '@mukuroji/contracts'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { DynamoDbSavedUpdateFeedsStore, InMemorySavedUpdateFeedsStore } from './saved-feeds-store'

/** Isolates AWS calls at the SDK command boundary. */
function clientFor(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // Replacing the overloaded SDK transport is the only cast; every command is validated below.
  client.send = send as DynamoDBDocumentClient['send']
  return client
}
const feed: SavedUpdateFeed = { id: 'mine', name: 'Mine', view: 'recent', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }
const checks: PlanningCallerAuthorizationConditionCheck[] = [{ ConditionCheck: { TableName: 'members', Key: { workspaceId: 'w', recordKey: 'MEMBER#reader' }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 2 } } }]

test('personal CRUD is isolated across sessions and Workspaces and rejects stale replacement', async () => {
  const store = new InMemorySavedUpdateFeedsStore()
  expect(await store.get('workspace', 'reader')).toEqual({ revision: 0, feeds: [] })
  expect(await store.replace('workspace', ' Reader ', { expectedRevision: 0, feeds: [feed] })).toMatchObject({ revision: 1 })
  expect(await store.get('workspace', 'reader')).toEqual({ revision: 1, feeds: [feed] })
  expect(await store.get('other', 'reader')).toEqual({ revision: 0, feeds: [] })
  expect(await store.get('workspace', 'other')).toEqual({ revision: 0, feeds: [] })
  await expect(store.replace('workspace', 'reader', { expectedRevision: 0, feeds: [] })).rejects.toMatchObject({ status: 409 })
  const edited = { ...feed, name: 'Edited', filters: { ...feed.filters, teamIds: ['t'] } }
  await store.replace('workspace', 'reader', { expectedRevision: 1, feeds: [edited] })
  expect(await store.get('workspace', 'reader')).toEqual({ revision: 2, feeds: [edited] })
  await expect(store.replace('workspace', 'reader', { expectedRevision: 1, feeds: [] })).rejects.toMatchObject({ status: 409 })
  await store.replace('workspace', 'reader', { expectedRevision: 2, feeds: [] })
  expect(await store.get('workspace', 'reader')).toEqual({ revision: 3, feeds: [] })
})

test('uses one consistent member-owned key and rejects malformed schema, identity and definitions', async () => {
  let mode = 'valid'
  const keys: unknown[] = []
  const store = new DynamoDbSavedUpdateFeedsStore('planning', clientFor(async (command) => {
    if (!(command instanceof GetCommand)) throw new Error('Unexpected command')
    expect(command.input.ConsistentRead).toBe(true)
    expect(command.input.Key?.workspaceId).toBe('w')
    expect(String(command.input.Key?.recordKey)).toStartWith('UPDATE_FEED_DEFINITIONS#')
    keys.push(command.input.Key)
    if (mode === 'missing') return {}
    return { Item: { ...command.input.Key, entryType: 'update-feed-definitions', schemaVersion: mode === 'schema' ? 9 : 1, revision: 1, feeds: mode === 'definition' ? [{ ...feed, view: 'bad' }] : [feed], ...(mode === 'identity' ? { workspaceId: 'other' } : {}) } }
  }))
  expect(await store.get('w', ' Reader ')).toEqual({ revision: 1, feeds: [feed] })
  await store.get('w', 'reader')
  expect(keys[0]).toEqual(keys[1])
  for (mode of ['schema', 'identity', 'definition']) await expect(store.get('w', 'reader')).rejects.toMatchObject({ status: 502 })
  mode = 'missing'
  expect(await store.get('w', 'reader')).toEqual({ revision: 0, feeds: [] })
})

test('atomically guards personal CAS and caller revocation without writing report content', async () => {
  let codes: string[] | undefined
  const unbound = new DynamoDbSavedUpdateFeedsStore('planning', clientFor(async (command) => {
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems
    expect(items).toHaveLength(2)
    expect(items?.[1]).toEqual(checks[0])
    expect(items?.[0]?.Put).toMatchObject({ ConditionExpression: '#revision = :revision AND #schema = :schema AND #type = :type', Item: { workspaceId: 'w', schemaVersion: 1, revision: 2, feeds: [feed] } })
    expect(Object.keys(items?.[0]?.Put?.Item ?? {}).sort()).toEqual(['entryType', 'feeds', 'recordKey', 'revision', 'schemaVersion', 'workspaceId'])
    if (codes) throw Object.assign(new Error('private storage detail'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) })
    return {}
  }))
  const input = { expectedRevision: 1, feeds: [feed] }
  await expect(unbound.replace('w', 'reader', input)).rejects.toMatchObject({ status: 503 })
  const bound = unbound.withCallerAuthorization(checks)
  expect(await bound.replace('w', 'reader', input)).toEqual({ revision: 2, feeds: [feed] })
  for (codes of [['ConditionalCheckFailed', 'None'], ['None', 'ConditionalCheckFailed']]) await expect(bound.replace('w', 'reader', input)).rejects.toMatchObject({ status: 409 })
  codes = ['ConditionalCheckFailed', 'ThrottlingError']
  await expect(bound.replace('w', 'reader', input)).rejects.toMatchObject({ status: 503 })
  codes = ['ConditionalCheckFailed']
  await expect(bound.replace('w', 'reader', input)).rejects.toMatchObject({ status: 502 })
})
