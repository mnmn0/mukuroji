import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { expect, test } from 'bun:test'
import { parseSlackIngestJob } from '../adapter-in/events/slack-ingest-sqs'
import { DynamoDbSlackIngestStore } from './dynamodb/slack-ingest-store'
import { parseSlackIngestSecret, SecretsManagerSlackIngestConfigSource } from './secrets-manager/secrets-manager-slack-ingest-config'
import { FetchSlackWebApi } from './slack/slack-web-api'
import { SlackRateLimitedError } from '../errors'

/** Command the fake client received. */
type SentCommand = {
  /** Command class name. */
  name: string
  /** Command input. */
  input: Record<string, unknown>
}

/**
 * Builds a document client that answers reads from a row map and records every command.
 *
 * @param rows - Rows keyed by record key.
 * @param fail - Error thrown by the first transaction, when set.
 * @returns The client and the recorded commands.
 */
function createClient(rows: Record<string, Record<string, unknown>>, fail?: Error) {
  const sent: SentCommand[] = []
  let failure = fail
  const client = {
    async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'GetCommand') {
        const key = Reflect.get(command.input, 'Key')
        const recordKey = typeof key === 'object' && key !== null ? Reflect.get(key, 'recordKey') : undefined
        return { Item: typeof recordKey === 'string' ? rows[recordKey] : undefined }
      }
      if (command.constructor.name === 'TransactWriteCommand' && failure) {
        const error = failure
        failure = undefined
        throw error
      }
      return {}
    },
  }
  return { client: client as unknown as DynamoDBDocumentClient, sent }
}

/** A stored message row. */
const messageRow = {
  workspaceId: 'w',
  recordKey: 'slack-ingest#message#C012345678#1700000000.000100',
  channelId: 'C012345678',
  ts: '1700000000.000100',
  userId: 'U012345678',
  text: 'MK-1',
  version: '1700000000.000100',
  keys: ['MK-1', 'MK-2'],
  permalink: 'https://example.slack.com/archives/C012345678/p1700000000000100',
  expiresAt: 1800000000,
}

test('a message write is conditional on the version read and replaces its key rows', async () => {
  const { client, sent } = createClient({ [messageRow.recordKey]: messageRow })
  const store = new DynamoDbSlackIngestStore('dev-platform', client)
  const outcome = await store.putMessage('w', {
    channelId: 'C012345678', ts: '1700000000.000100', userId: 'U012345678', text: 'MK-2 MK-3',
    version: '1700000100.000000', editedTs: '1700000100.000000', keys: ['MK-2', 'MK-3'],
    permalink: messageRow.permalink, expiresAt: 1800000000,
  })
  expect(outcome).toBe('written')
  const transaction = sent.find((command) => command.name === 'TransactWriteCommand')
  const items = transaction?.input.TransactItems
  expect(items).toEqual([
    {
      Put: expect.objectContaining({
        ConditionExpression: '#version = :previousVersion',
        ExpressionAttributeValues: { ':previousVersion': '1700000000.000100' },
      }),
    },
    { Delete: { TableName: 'dev-platform', Key: { workspaceId: 'w', recordKey: 'slack-ingest#key#MK-1#C012345678#1700000000.000100' } } },
    { Put: expect.objectContaining({ Item: expect.objectContaining({ recordKey: 'slack-ingest#key#MK-2#C012345678#1700000000.000100', expiresAt: 1800000000 }) }) },
    { Put: expect.objectContaining({ Item: expect.objectContaining({ recordKey: 'slack-ingest#key#MK-3#C012345678#1700000000.000100' }) }) },
  ])
})

test('an older version or a tombstone is not written', async () => {
  const { client, sent } = createClient({
    [messageRow.recordKey]: { ...messageRow, version: '1700000500.000000' },
    'slack-ingest#message#C012345678#1700000001.000100': {
      workspaceId: 'w', recordKey: 'slack-ingest#message#C012345678#1700000001.000100', channelId: 'C012345678',
      ts: '1700000001.000100', version: '1700000600.000000', deleted: true, expiresAt: 1700100000,
    },
  })
  const store = new DynamoDbSlackIngestStore('dev-platform', client)
  const base = { userId: 'U012345678', text: 'x', keys: [], permalink: 'https://example.slack.com/x', expiresAt: 1800000000, channelId: 'C012345678' }
  expect(await store.putMessage('w', { ...base, ts: '1700000000.000100', version: '1700000100.000000' })).toBe('stale')
  expect(await store.putMessage('w', { ...base, ts: '1700000001.000100', version: '1700000002.000000' })).toBe('stale')
  expect(sent.some((command) => command.name === 'TransactWriteCommand')).toBe(false)
})

test('a malformed stored row fails closed', async () => {
  const { client } = createClient({ 'slack-ingest#channel#C012345678': { recordKey: 'slack-ingest#channel#C012345678', channelId: 'C012345678' } })
  const store = new DynamoDbSlackIngestStore('dev-platform', client)
  await expect(store.getChannel('w', 'C012345678')).rejects.toMatchObject({ code: 'SlackIngestRowInvalid' })
})

test('a mapping change is conditional on the mapping revision and is audited', async () => {
  const conditionFailure = Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  })
  const { client, sent } = createClient({}, conditionFailure)
  const store = new DynamoDbSlackIngestStore('dev-platform', client)
  await expect(store.setChannelTarget('w', 'C012345678', { kind: 'team', teamId: 'team-a' }, 3, {
    context: undefined as never,
    now: '2026-11-28T00:00:00.000Z',
  })).rejects.toMatchObject({ code: 'SlackChannelMappingConflict' })
  const update = sent.find((command) => command.name === 'TransactWriteCommand')?.input.TransactItems
  expect(update).toEqual([{
    Update: expect.objectContaining({
      ConditionExpression: 'attribute_exists(recordKey) AND mappingRevision = :expected',
      ExpressionAttributeValues: expect.objectContaining({ ':expected': 3, ':next': 4, ':target': { kind: 'team', teamId: 'team-a' } }),
    }),
  }])
})

test('queued jobs are rebuilt from allowlisted fields only', () => {
  expect(parseSlackIngestJob(JSON.stringify({
    kind: 'event', workspaceId: 'w', eventId: 'Ev1',
    event: {
      kind: 'message-posted', channelKind: 'public',
      message: { channelId: 'C012345678', ts: '1700000000.000100', userId: 'U012345678', text: 'hi', version: '1700000000.000100', extra: 'dropped' },
    },
  }))).toEqual({
    kind: 'event', workspaceId: 'w', eventId: 'Ev1',
    event: { kind: 'message-posted', channelKind: 'public', message: { channelId: 'C012345678', ts: '1700000000.000100', userId: 'U012345678', text: 'hi', version: '1700000000.000100' } },
  })
  expect(parseSlackIngestJob(JSON.stringify({ kind: 'prune', workspaceId: 'w', channelId: 'C012345678', mode: 'all', mappingRevision: 2 })))
    .toEqual({ kind: 'prune', workspaceId: 'w', channelId: 'C012345678', mode: 'all', mappingRevision: 2 })
  expect(() => parseSlackIngestJob(JSON.stringify({ kind: 'prune', workspaceId: 'w', channelId: 'bad', mode: 'all', mappingRevision: 2 }))).toThrow(TypeError)
  expect(() => parseSlackIngestJob('not json')).toThrow()
})

test('the secret must hold every field in its expected shape', () => {
  const valid = { signingSecret: '0123456789abcdef0123456789abcdef', botToken: 'xoxb-123-456-abcdef', teamId: 'T012345678', workspaceId: 'ws-1' }
  expect(parseSlackIngestSecret(JSON.stringify(valid))).toEqual(valid)
  expect(parseSlackIngestSecret(JSON.stringify({ ...valid, appId: 'A012345678' }))).toMatchObject({ appId: 'A012345678' })
  for (const broken of [{ ...valid, botToken: 'xoxp-user' }, { ...valid, teamId: 'x' }, { ...valid, workspaceId: '' }]) {
    expect(() => parseSlackIngestSecret(JSON.stringify(broken))).toThrow()
  }
  expect(() => parseSlackIngestSecret('{')).toThrow()
})

test('a missing secret means not configured, and reads are cached', async () => {
  let calls = 0
  const missing = Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' })
  const client = { async send() { calls += 1; throw missing } } as unknown as SecretsManagerClient
  const source = new SecretsManagerSlackIngestConfigSource(client, 'mukuroji/slack-ingest', () => 1_000)
  expect(await source.read()).toBeUndefined()
  expect(await source.read()).toBeUndefined()
  expect(calls).toBe(1)
})

test('the Web API client posts to slack.com with the bot token and maps 429', async () => {
  const requests: { url: string, init: RequestInit }[] = []
  const responses = [
    new Response(JSON.stringify({ ok: true, messages: [{ ts: '1' }], has_more: true, response_metadata: { next_cursor: 'abc' } })),
    new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
    new Response(JSON.stringify({ ok: false, error: 'not_in_channel' })),
  ]
  const api = new FetchSlackWebApi('xoxb-1-2-token', async (url, init) => {
    requests.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error('no response')
    return response
  })
  expect(await api.history('C012345678', '1700000000.000000')).toEqual({ messages: [{ ts: '1' }], nextCursor: 'abc' })
  expect(requests[0]?.url).toBe('https://slack.com/api/conversations.history')
  expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe('Bearer xoxb-1-2-token')
  expect(String(requests[0]?.init.body)).toContain('channel=C012345678')
  const limited = await api.authTest().catch((error: unknown) => error)
  expect(limited).toBeInstanceOf(SlackRateLimitedError)
  expect(limited).toMatchObject({ retryAfterSeconds: 7 })
  await expect(api.conversationInfo('C012345678')).rejects.toMatchObject({ code: 'SlackApiError' })
})
