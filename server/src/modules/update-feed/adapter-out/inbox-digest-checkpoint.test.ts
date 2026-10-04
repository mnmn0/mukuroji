import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbInboxDigestCheckpoints } from './inbox-digest-checkpoint'
import { runInboxDigestWorker, runInboxDigestWorkerInvocation, type InboxDigestWorkerDependencies } from '../application/inbox-digest-worker'
import { PlanningError } from '../../planning'
import { TenantAdministrationError } from '../../tenant-administration'
import { InMemoryUpdateFeedDigestStore } from './digest-store'
import { InMemoryUpdateFeedReadStateStore } from './read-state-store'
import { InMemoryPlanningClient } from '../../planning/planning'

const start = Date.parse('2026-10-03T12:00:00Z')
const recipient = { workspaceId: 'workspace', memberKey: 'reader' }
const candidate = { ...recipient, frequency: 'daily' as const }
const terminalFailure = { work: { recipient, frequency: 'daily' as const, scheduledAt: start, attempts: 2 }, reason: 'retry-exhausted' as const }

for (const frequency of ['daily', 'weekly'] as const) for (const cadenceChanged of [false, true]) test(`twenty preclaim conflicts preserve ${frequency} work across restart with cadenceChanged=${cadenceChanged}`, async () => {
  const f = fixture()
  const metadata = new InMemoryUpdateFeedDigestStore()
  const scheduledAt = Date.parse('2026-10-04T23:59:30Z')
  let clock = scheduledAt
  let blocked = true
  let discoveryFrequency = frequency
  const owners = Array.from({ length: 20 }, (_, index) => ({ ...recipient, memberKey: `reader-${index}` }))
  const healthy = { ...recipient, memberKey: 'healthy' }
  for (const owner of [...owners, healthy]) {
    const state = await metadata.get(owner.workspaceId, owner.memberKey)
    await metadata.replace(owner.workspaceId, owner.memberKey, { ...state, preferences: { enabled: true, frequency, views: ['recent'] } })
  }
  const cursors: (string | undefined)[] = []
  const dependencies: InboxDigestWorkerDependencies = {
    checkpoints: f.store, now: () => clock,
    listDue: async (_shard, cursor) => { cursors.push(cursor); return cursor === 'page-2' ? { recipients: [{ ...healthy, frequency }] } : { recipients: owners.map((owner) => ({ ...owner, frequency: discoveryFrequency })), cursor: 'page-2' } },
    delivery: { authorize: async (owner) => {
      if (owner.memberKey !== 'healthy' && blocked) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Preclaim revision changed')
      return {
        recipient: owner, authorizationRevision: 0,
        reader: { memberKey: owner.memberKey, readSnapshot: () => new InMemoryPlanningClient().get(owner.workspaceId, { workItems: [] }), authorizeTarget: async () => undefined },
        readState: new InMemoryUpdateFeedReadStateStore(),
        store: {
          get: metadata.get.bind(metadata), replace: metadata.replace.bind(metadata),
          complete: async (_recipient, state) => {
            expect((await metadata.get(owner.workspaceId, owner.memberKey)).history.at(-1)?.leaseUntil).toBe(clock + 60_000)
            return metadata.replace(owner.workspaceId, owner.memberKey, state)
          },
        },
      }
    } },
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await runInboxDigestWorker(dependencies, 0)).toMatchObject({ processed: 20, deferred: 20, failed: 0 })
    clock += 60_000
  }
  expect(f.rows.get('SHARD#0')?.pending).toEqual([])
  expect(f.rows.get('SHARD#0')?.cursor).toBe('page-2')
  expect([...f.rows.values()].filter((row) => row.entryType === 'inbox-digest-deferred')).toHaveLength(20)
  for (const owner of owners) {
    expect(await f.store.readDeferred(owner)).toEqual({ recipient: owner, attempts: 0, conflicts: 2, scheduledAt, frequency })
    expect(await f.store.isQuarantined(owner, clock)).toBe(false)
  }
  expect((await runInboxDigestWorker(dependencies, 0)).processed).toBe(1)
  expect((await metadata.get(healthy.workspaceId, healthy.memberKey)).history).toMatchObject([{ status: 'completed' }])
  blocked = false
  if (cadenceChanged) {
    discoveryFrequency = frequency === 'daily' ? 'weekly' : 'daily'
    for (const owner of owners) {
      const state = await metadata.get(owner.workspaceId, owner.memberKey)
      await metadata.replace(owner.workspaceId, owner.memberKey, { ...state, preferences: { ...state.preferences, frequency: discoveryFrequency } })
    }
  }
  dependencies.checkpoints = f.restart()
  expect((await runInboxDigestWorker(dependencies, 0)).processed).toBe(20)
  expect(cursors).toEqual([undefined, 'page-2', undefined])
  for (const owner of owners) {
    expect((await metadata.get(owner.workspaceId, owner.memberKey)).history).toMatchObject(cadenceChanged ? [] : [{ id: `${frequency}:${frequency === 'daily' ? '2026-10-04' : '2026-09-28'}`, startedAt: clock, status: 'completed' }])
    expect(await f.store.readDeferred(owner)).toBeUndefined()
  }
  if (cadenceChanged) {
    await runInboxDigestWorker(dependencies, 0)
    await runInboxDigestWorker(dependencies, 0)
    for (const owner of owners) expect((await metadata.get(owner.workspaceId, owner.memberKey)).history).toMatchObject([{ id: `${discoveryFrequency}:2026-10-05`, startedAt: clock, status: 'completed' }])
  }
})

test('legacy work without a pinned cadence is cancelled rather than generating a guessed historical interval', async () => {
  const f = fixture()
  const state = (await f.store.claim(0, start))!
  await f.store.save({ ...state, pending: [{ recipient, attempts: 1, scheduledAt: start - 86_400_000 }] }, start, true)
  let authorized = 0
  const result = await runInboxDigestWorker({ checkpoints: f.store, now: () => start, listDue: async () => ({ recipients: [] }), delivery: { authorize: async () => { authorized++; return undefined } } }, 0)
  expect(result).toEqual({ processed: 1, delivered: 0, failed: 0, deferred: 0 })
  expect(authorized).toBe(0)
  expect(f.rows.get('SHARD#0')?.pending).toEqual([])
})

test('stored cadence without its logical time fails closed instead of rebinding an interval', async () => {
  const f = fixture()
  await f.store.claim(0, start)
  f.rows.get('SHARD#0')!.pending = [{ recipient, attempts: 0, frequency: 'daily' }]
  await expect(f.store.claim(0, start + 90_000)).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
})

test('park and acknowledgment survive response loss and reject stale checkpoint owners atomically', async () => {
  const f = fixture()
  const owned = (await f.store.claim(0, start))!
  const item = { recipient, attempts: 1, conflicts: 2, scheduledAt: start - 86_400_000 }
  const pending = await f.store.save({ ...owned, pending: [item], cursor: 'next' }, start, false)
  f.loseResponse()
  await expect(f.store.save({ ...pending, pending: [] }, start, false, undefined, { kind: 'park', item })).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
  expect(await f.restart().readDeferred(recipient)).toEqual(item)
  expect(f.rows.get('SHARD#0')?.pending).toEqual([])
  expect(f.rows.get('SHARD#0')?.cursor).toBe('next')
  await expect(f.store.save({ ...pending, pending: [] }, start, false, undefined, { kind: 'finish', item })).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect(await f.store.readDeferred(recipient)).toEqual(item)
  const resumed = (await f.store.claim(0, start + 90_000))!
  f.loseResponse()
  await expect(f.store.save(resumed, start + 90_000, true, undefined, { kind: 'finish', item })).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
  expect(await f.store.readDeferred(recipient)).toBeUndefined()
  expect((await f.store.claim(0, start + 90_001))?.pending).toEqual([])
})

test('parked state corruption is distinct from SDK failure and never silently loses its logical time', async () => {
  const f = fixture()
  const state = (await f.store.claim(0, start))!
  await f.store.save(state, start, true, undefined, { kind: 'park', item: { recipient, attempts: 1, scheduledAt: start } })
  const row = [...f.rows.values()].find((item) => item.entryType === 'inbox-digest-deferred')!
  row.pending = { recipient, attempts: 1 }
  await expect(f.store.readDeferred(recipient)).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
  f.failCommand(() => new Error('Unknown transport failure'))
  await expect(f.store.readDeferred(recipient)).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
})

/** Models actual generated transaction conditions; no external storage is accessed. */
function fixture() {
  const rows = new Map<string, Record<string, unknown>>()
  let loseResponse = false
  let sdkFailure: ((command: unknown) => unknown) | undefined
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // The SDK's overloaded signature is the only assertion in this isolated model.
  client.send = (async (command: unknown) => {
    const injected = sdkFailure?.(command)
    if (injected !== undefined) throw injected
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true)
      return { Item: structuredClone(rows.get(String(command.input.Key?.recordKey))) }
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected command')
    const items = command.input.TransactItems ?? []
    const reasons = items.map(({ Put, Delete }) => {
      if (Delete) return { Code: 'None' }
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
    for (const { Put, Delete } of items) {
      if (Put?.Item) rows.set(String(Put.Item.recordKey), structuredClone(Put.Item))
      if (Delete?.Key) rows.delete(String(Delete.Key.recordKey))
    }
    if (loseResponse) { loseResponse = false; throw new Error('Lost acknowledgement') }
    return {}
  }) as DynamoDBDocumentClient['send']
  return {
    rows, store: new DynamoDbInboxDigestCheckpoints('planning', client),
    /** Recreates the adapter while keeping only durable rows. */
    restart() { return new DynamoDbInboxDigestCheckpoints('planning', client) },
    /** Loses the next transaction response after atomic commit. */
    loseResponse() { loseResponse = true },
    /** Injects a read or write transport failure after fixture initialization. */
    failCommand(failure: (command: unknown) => unknown) { sdkFailure = failure },
  }
}

for (const boundary of ['claim-read', 'quarantine-read', 'claim-write', 'save', 'save-failure']) for (const [name, status, code] of [
  ['TimeoutError', 503, 'UpdateFeedDigestRetryable'],
  ['AccessDeniedException', 502, 'UpdateFeedDigestStoragePermanent'],
  ['UnclassifiedNetworkFailure', 502, 'UpdateFeedDigestStorageFailure'],
] as const) test(`checkpoint ${boundary} classifies ${name}`, async () => {
  const f = fixture()
  const owned = (await f.store.claim(0, start))!
  const before = structuredClone([...f.rows])
  f.failCommand((command) => (boundary.endsWith('read') ? command instanceof GetCommand : command instanceof TransactWriteCommand) ? Object.assign(new Error('Private SDK detail'), { name }) : undefined)
  const operation = boundary === 'quarantine-read' ? f.store.isQuarantined(recipient, start) : boundary.startsWith('claim') ? f.store.claim(1, start) : f.store.save(owned, start, true, boundary === 'save-failure' ? terminalFailure : undefined)
  await expect(operation).rejects.toMatchObject({ status, code })
  expect([...f.rows]).toEqual(before)
})

for (const code of ['UpdateFeedDigestRetryable', 'UpdateFeedDigestStoragePermanent', 'UpdateFeedDigestStorageFailure', 'UpdateFeedDigestCorruptState']) test(`candidate invocation ${code} never advances cursor or acknowledges pending work`, async () => {
  const f = fixture()
  const owned = (await f.store.claim(0, start))!
  await f.store.save({ ...owned, cursor: 'unchanged', pending: [{ recipient, attempts: 1 }] }, start, true)
  let deliveries = 0
  await expect(runInboxDigestWorker({ checkpoints: f.store, now: () => start, listDue: async () => { throw new PlanningError(code === 'UpdateFeedDigestRetryable' ? 503 : 502, code, 'Unavailable') }, delivery: { authorize: async () => { deliveries++; return undefined } } }, 0)).rejects.toMatchObject({ code })
  expect(deliveries).toBe(0)
  expect(f.rows.get('SHARD#0')?.cursor).toBe('unchanged')
  expect(f.rows.get('SHARD#0')?.pending).toEqual([{ recipient, attempts: 1 }])
})

test('quarantine parsing failures remain distinct from invalid caller checkpoint input', async () => {
  const f = fixture()
  const owned = (await f.store.claim(0, start))!
  await f.store.save(owned, start, true, terminalFailure)
  const failure = [...f.rows.values()].find((row) => row.entryType === 'inbox-digest-failure')!
  failure.schemaVersion = 99
  await expect(f.store.isQuarantined(recipient, start)).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
  await expect(f.store.save({ ...owned, pending: [{ recipient, attempts: 99 }] }, start, false)).rejects.toMatchObject({ code: 'UpdateFeedDigestInvalid' })
})

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
  await expect(f.store.save({ ...owned, pending: [{ recipient, attempts: 2 }], cursor: 'continued' }, start, false)).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
  const resumed = (await f.store.claim(1, start + 90_000))!
  expect(resumed.pending).toEqual([{ recipient, attempts: 2 }])
  await expect(f.store.save({ ...owned, pending: [] }, start, false, terminalFailure)).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect(await f.store.isQuarantined(recipient, start)).toBe(false)
  expect(await f.store.isExhausted(candidate, start)).toBe(false)
  f.loseResponse()
  await expect(f.store.save({ ...resumed, pending: [] }, start + 90_001, true, terminalFailure)).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
  expect(await f.store.isQuarantined(recipient, start)).toBe(true)
  expect(await f.restart().isExhausted(candidate, start)).toBe(true)
  expect(await f.restart().isExhausted({ ...candidate, scheduledAt: start }, start + 86_400_000)).toBe(true)
  expect(await f.store.isQuarantined(recipient, start + 86_400_000)).toBe(false)
  expect((await f.store.claim(1, start + 90_002))?.pending).toEqual([])
})

test('exhaustion evidence fails closed on corruption and does not disguise SDK failures', async () => {
  const f = fixture()
  const owned = (await f.store.claim(0, start))!
  await f.store.save(owned, start, true, terminalFailure)
  const row = [...f.rows.values()].find((value) => value.entryType === 'inbox-digest-exhaustion')!
  row.work = { ...terminalFailure.work, scheduledAt: start + 86_400_000 }
  await expect(f.store.isExhausted(candidate, start)).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
  f.failCommand(() => Object.assign(new Error('Private network failure'), { name: 'TimeoutError' }))
  await expect(f.store.isExhausted(candidate, start)).rejects.toMatchObject({ code: 'UpdateFeedDigestRetryable' })
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
      return { recipients: cursor ? [] : [candidate], cursor: cursor ? undefined : 'page-2' }
    },
    delivery: { async authorize() {
      seen++
      expect(f.rows.get('SHARD#2')?.pending).toEqual([{ recipient, attempts: 0, scheduledAt: start, frequency: 'daily' }])
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

for (const code of ['UpdateFeedDigestRetryable', 'UpdateFeedDigestStorageFailure', 'UpdateFeedReadStateStorageFailure', 'TenantAdministrationUnavailable']) test(`worker bounds ${code} recovery to three attempts with backoff and quarantine`, async () => {
  const f = fixture()
  let clock = start
  let calls = 0
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue() { return { recipients: await f.store.isQuarantined(recipient, clock) ? [] : [candidate, candidate] } },
    delivery: { async authorize() { calls++; throw code === 'TenantAdministrationUnavailable' ? new TenantAdministrationError(503, code, 'Unavailable') : new PlanningError(code === 'UpdateFeedDigestRetryable' ? 503 : 502, code, 'Unavailable') } },
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await runInboxDigestWorker(dependencies, 3)).toEqual({ processed: 1, delivered: 0, failed: 1, deferred: 0 })
    expect(await runInboxDigestWorker(dependencies, 3)).toEqual({ processed: 0, delivered: 0, failed: 0, deferred: 0 })
    clock += 60_000
  }
  expect(calls).toBe(3)
  expect(await f.store.isQuarantined(recipient, clock)).toBe(true)
  expect(f.rows.get('SHARD#3')?.pending).toEqual([])
  expect(await runInboxDigestWorker(dependencies, 3)).toEqual({ processed: 0, delivered: 0, failed: 0, deferred: 0 })
  expect(calls).toBe(3)
})

for (const code of ['UpdateFeedDigestStoragePermanent', 'UpdateFeedDigestCorruptState', 'UpdateFeedReadStateCorrupt', 'UpdateFeedDuplicateTarget', 'TenantAdministrationCorrupt', 'UpdateFeedDigestInvalid']) test(`worker quarantines ${code} on the first attempt instead of retrying`, async () => {
  const f = fixture()
  let clock = start
  let calls = 0
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue() { return { recipients: await f.store.isQuarantined(recipient, clock) ? [] : [candidate] } },
    delivery: { async authorize() { calls++; throw code === 'TenantAdministrationCorrupt' ? new TenantAdministrationError(502, code, 'Storage requires inspection') : new PlanningError(502, code, 'Storage requires inspection') } },
  }
  expect(await runInboxDigestWorker(dependencies, 5)).toEqual({ processed: 1, delivered: 0, failed: 1, deferred: 0 })
  expect(await f.store.isQuarantined(recipient, clock)).toBe(true)
  expect(f.rows.get('SHARD#5')?.pending).toEqual([])
  clock += 60_000
  expect(await runInboxDigestWorker(dependencies, 5)).toEqual({ processed: 0, delivered: 0, failed: 0, deferred: 0 })
  expect(calls).toBe(1)
})

test('unknown failure can recover on the next bounded attempt without quarantine', async () => {
  const f = fixture()
  let clock = start
  let calls = 0
  const dependencies = { checkpoints: f.store, now: () => clock, async listDue() { return { recipients: [candidate] } }, delivery: { async authorize() {
    if (++calls === 1) throw new PlanningError(502, 'UpdateFeedDigestStorageFailure', 'Unknown SDK failure')
    return undefined
  } } }
  expect(await runInboxDigestWorker(dependencies, 6)).toEqual({ processed: 1, delivered: 0, failed: 1, deferred: 0 })
  expect(await f.store.isQuarantined(recipient, clock)).toBe(false)
  clock += 60_000
  expect(await runInboxDigestWorker(dependencies, 6)).toEqual({ processed: 1, delivered: 0, failed: 0, deferred: 0 })
  expect(await f.store.isQuarantined(recipient, clock)).toBe(false)
  expect(f.rows.get('SHARD#6')?.pending).toEqual([])
})

test('unknown persisted schema fails closed instead of resetting the queue', async () => {
  const f = fixture()
  const owned = (await f.store.claim(4, start))!
  await f.store.save(owned, start, true)
  f.rows.get('SHARD#4')!.schemaVersion = 2
  await expect(f.store.claim(4, start)).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
  await expect(f.store.claim(16, start)).rejects.toThrow('Invalid')
})

test('rotation survives crashes, lost acknowledgements and concurrent reservations', async () => {
  const f = fixture()
  expect(await f.store.reserveStartShard()).toBe(0) // Simulate crash before any shard work.
  expect(await f.restart().reserveStartShard()).toBe(1)
  const concurrent = await Promise.all([f.restart().reserveStartShard(), f.restart().reserveStartShard()])
  expect(concurrent.sort()).toEqual([2, 3])
  f.loseResponse()
  await expect(f.store.reserveStartShard()).rejects.toMatchObject({ code: 'UpdateFeedDigestStorageFailure' })
  expect(await f.restart().reserveStartShard()).toBe(5)
  f.rows.get('ROTATION')!.nextShard = 16
  await expect(f.store.reserveStartShard()).rejects.toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
})

for (const cadence of [3_600_000, 86_400_000]) test(`durable rotation reaches every busy shard with cadence ${cadence}`, async () => {
  const f = fixture()
  let clock = start
  const firstShards: number[] = []
  for (let invocation = 0; invocation < 16; invocation++) {
    clock = start + invocation * cadence
    const began = clock
    const shards: number[] = []
    const result = await runInboxDigestWorkerInvocation({
      checkpoints: f.restart(), now: () => clock,
      async listDue(shard, _cursor, limit) {
        expect(clock - began).toBeLessThan(150_000)
        expect(limit).toBeLessThanOrEqual(20)
        shards.push(shard)
        return { recipients: [candidate] }
      },
      delivery: { async authorize() { clock += 80_000; return undefined } },
    })
    firstShards.push(shards[0]!)
    expect(shards).toHaveLength(2)
    expect(result).toEqual({ processed: 2, delivered: 0, failed: 0, deferred: 0 })
  }
  expect(firstShards).toEqual(Array.from({ length: 16 }, (_, index) => index))
})

for (const recovery of ['revoked', 'optout', 'cas']) test(`known conflicts defer without infrastructure retries and re-evaluate ${recovery}`, async () => {
  const f = fixture()
  const metadata = new InMemoryUpdateFeedDigestStore()
  const initial = await metadata.get(recipient.workspaceId, recipient.memberKey)
  await metadata.replace(recipient.workspaceId, recipient.memberKey, { ...initial, preferences: { ...initial.preferences, enabled: recovery === 'cas' } })
  let clock = start
  let calls = 0
  const dependencies = {
    checkpoints: f.store, now: () => clock,
    async listDue() { return { recipients: [candidate] } },
    delivery: { async authorize() {
      if (++calls <= 4) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Current state changed')
      if (recovery === 'revoked') return undefined
      return {
        recipient, authorizationRevision: 0,
        reader: { memberKey: recipient.memberKey, readSnapshot: () => new InMemoryPlanningClient().get(recipient.workspaceId, { workItems: [] }), authorizeTarget: async () => undefined },
        readState: new InMemoryUpdateFeedReadStateStore(),
        store: {
          get: (workspaceId: string, memberKey: string) => metadata.get(workspaceId, memberKey),
          replace: metadata.replace.bind(metadata),
          complete: (_owner: typeof recipient, state: Awaited<ReturnType<typeof metadata.get>>) => metadata.replace(recipient.workspaceId, recipient.memberKey, state),
        },
      }
    } },
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await runInboxDigestWorker(dependencies, 7)).toEqual({ processed: 1, delivered: 0, failed: 0, deferred: 1 })
    expect(f.rows.get('SHARD#7')?.pending).toEqual(attempt === 2 ? [] : [{ recipient, attempts: 0, scheduledAt: start, frequency: 'daily', conflicts: attempt === 3 ? 1 : attempt + 1 }])
    expect(await f.store.isQuarantined(recipient, clock)).toBe(false)
    expect(await runInboxDigestWorker(dependencies, 7)).toEqual({ processed: 0, delivered: 0, failed: 0, deferred: 0 })
    clock += 60_000
  }
  expect(await runInboxDigestWorker(dependencies, 7)).toEqual({ processed: 1, delivered: 0, failed: 0, deferred: 0 })
  expect(calls).toBe(5)
  expect(f.rows.get('SHARD#7')?.pending).toEqual([])
  expect((await metadata.get(recipient.workspaceId, recipient.memberKey)).history).toMatchObject(recovery === 'cas' ? [{ status: 'completed' }] : [])
})
