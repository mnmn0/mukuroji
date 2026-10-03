import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbInboxDigestCheckpoints } from './inbox-digest-checkpoint'
import { runInboxDigestWorker } from '../application/inbox-digest-worker'
import { PlanningError } from '../../planning'

const start = Date.parse('2026-10-03T12:00:00Z')
const recipient = { workspaceId: 'workspace', memberKey: 'reader' }

/** Models actual generated transaction conditions; no external storage is accessed. */
function fixture() {
  const rows = new Map<string, Record<string, unknown>>()
  let loseResponse = false
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // The SDK's overloaded signature is the only assertion in this isolated model.
  client.send = (async (command: unknown) => {
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true)
      return { Item: structuredClone(rows.get(String(command.input.Key?.recordKey))) }
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems ?? []
    const reasons = items.map(({ Put }) => {
      if (!Put?.Item) throw new Error('Expected Put')
      const row = rows.get(String(Put.Item.recordKey))
      const names = Put.ExpressionAttributeNames ?? {}
      const values = Put.ExpressionAttributeValues ?? {}
      const valid = Put.ConditionExpression?.split(' AND ').every((part) => {
        if (part === 'attribute_not_exists(recordKey)') return row === undefined
        const match = /^(\S+) (=|<=|>) (\S+)$/.exec(part)
        if (!match) throw new Error(`Unsupported model expression: ${part}`)
        const actual = row?.[names[match[1]!] ?? match[1]!]
        const expected = values[match[3]!]
        if (match[2] === '=') return actual === expected
        return typeof actual === 'number' && typeof expected === 'number' && (match[2] === '<=' ? actual <= expected : actual > expected)
      }) ?? true
      return { Code: valid ? 'None' : 'ConditionalCheckFailed' }
    })
    if (reasons.some(({ Code }) => Code !== 'None')) throw Object.assign(new Error('Conditional failure'), { name: 'TransactionCanceledException', CancellationReasons: reasons })
    for (const { Put } of items) if (Put?.Item) rows.set(String(Put.Item.recordKey), structuredClone(Put.Item))
    if (loseResponse) { loseResponse = false; throw new Error('Lost acknowledgement') }
    return {}
  }) as DynamoDBDocumentClient['send']
  return {
    rows, store: new DynamoDbInboxDigestCheckpoints('planning', client),
    /** Loses the next transaction response after atomic commit. */
    loseResponse() { loseResponse = true },
  }
}

test('exclusive durable claims survive restart and fence expired workers', async () => {
  const f = fixture()
  const claims = await Promise.all([f.store.claim(0, start), f.store.claim(0, start)])
  expect(claims.filter(Boolean)).toHaveLength(1)
  const owned = claims.find(Boolean)!
  const saved = await f.store.save({ ...owned, cursor: 'next-page', pending: [{ recipient, attempts: 1 }] }, start, false)
  expect(await f.store.claim(0, start + 89_999)).toBeUndefined()
  const restarted = (await f.store.claim(0, start + 90_000))!
  expect(restarted.pending).toEqual(saved.pending)
  expect(restarted.cursor).toBe('next-page')
  expect(restarted.token).not.toBe(saved.token)
  await expect(f.store.save(saved, start + 90_001, true)).rejects.toThrow()
  await f.store.save(restarted, start + 90_001, true)
})

test('lost page acknowledgement retains pending work and terminal failures commit atomically', async () => {
  const f = fixture()
  const owned = (await f.store.claim(1, start))!
  f.loseResponse()
  await expect(f.store.save({ ...owned, pending: [{ recipient, attempts: 2 }], cursor: 'continued' }, start, false)).rejects.toThrow('Lost acknowledgement')
  const resumed = (await f.store.claim(1, start + 90_000))!
  expect(resumed.pending).toEqual([{ recipient, attempts: 2 }])
  await expect(f.store.save({ ...owned, pending: [] }, start, false, recipient)).rejects.toThrow('Conditional failure')
  expect(await f.store.isQuarantined(recipient, start)).toBe(false)
  f.loseResponse()
  await expect(f.store.save({ ...resumed, pending: [] }, start + 90_001, true, recipient)).rejects.toThrow('Lost acknowledgement')
  expect(await f.store.isQuarantined(recipient, start)).toBe(true)
  expect(await f.store.isQuarantined(recipient, start + 86_400_000)).toBe(false)
  expect((await f.store.claim(1, start + 90_002))?.pending).toEqual([])
})

test('worker persists bounded continuation before delivery and resumes after a crash', async () => {
  const f = fixture()
  let clock = start
  let seen = 0
  const cursors: (string | undefined)[] = []
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue(_shard: number, cursor: string | undefined, limit: number) {
      cursors.push(cursor)
      expect(limit).toBeLessThanOrEqual(20)
      return { recipients: cursor ? [] : [recipient], cursor: cursor ? undefined : 'page-2' }
    },
    delivery: { async authorize() {
      seen++
      expect(f.rows.get('SHARD#2')?.pending).toEqual([{ recipient, attempts: 0 }])
      if (seen === 1) clock += 90_001
      return undefined // Revoked recipients never reach delivery storage.
    } },
  }
  await expect(runInboxDigestWorker(dependencies, 2)).rejects.toThrow()
  expect((await runInboxDigestWorker(dependencies, 2)).processed).toBe(1)
  expect(cursors).toEqual([undefined, 'page-2'])
  expect(f.rows.get('SHARD#2')?.pending).toEqual([])
  expect(seen).toBe(2)
})

test('worker quarantines after three failures, backs off and bounds duplicate batches', async () => {
  const f = fixture()
  let clock = start
  let calls = 0
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue() { return { recipients: [recipient, recipient] } },
    delivery: { async authorize() { calls++; throw new Error('Unavailable') } },
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await runInboxDigestWorker(dependencies, 3)).toEqual({ processed: 1, delivered: 0, failed: 1 })
    expect(await runInboxDigestWorker(dependencies, 3)).toEqual({ processed: 0, delivered: 0, failed: 0 })
    clock += 60_000
  }
  expect(calls).toBe(3)
  expect(await f.store.isQuarantined(recipient, clock)).toBe(true)
  expect(f.rows.get('SHARD#3')?.pending).toEqual([])
})

test('worker quarantines permanent storage failures on the first attempt instead of retrying them', async () => {
  const f = fixture()
  let clock = start
  let calls = 0
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue() { return { recipients: await f.store.isQuarantined(recipient, clock) ? [] : [recipient] } },
    delivery: { async authorize() { calls++; throw new PlanningError(502, 'UpdateFeedDigestStorageFailure', 'Storage configuration unavailable') } },
  }
  expect(await runInboxDigestWorker(dependencies, 5)).toEqual({ processed: 1, delivered: 0, failed: 1 })
  expect(await f.store.isQuarantined(recipient, clock)).toBe(true)
  expect(f.rows.get('SHARD#5')?.pending).toEqual([])
  clock += 60_000
  expect(await runInboxDigestWorker(dependencies, 5)).toEqual({ processed: 0, delivered: 0, failed: 0 })
  expect(calls).toBe(1)
})

test('unknown persisted schema fails closed instead of resetting the queue', async () => {
  const f = fixture()
  const owned = (await f.store.claim(4, start))!
  await f.store.save(owned, start, true)
  f.rows.get('SHARD#4')!.schemaVersion = 2
  await expect(f.store.claim(4, start)).rejects.toThrow('Invalid')
  await expect(f.store.claim(16, start)).rejects.toThrow('Invalid')
})
