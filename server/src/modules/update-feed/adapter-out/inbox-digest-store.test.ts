import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { PlanningCallerAuthorizationConditionCheck } from '../../planning'
import { InMemoryPlanningClient } from '../../planning/planning'
import { NOTIFICATION_PREFERENCES_KEY, createNotificationRecipientKey, toNotificationItem } from '../../notifications'
import { emptyDigestState } from '../application/digest'
import { deliverInboxDigest, inboxDigestTerminalReason, runInboxDigestSchedule, type InboxDigestContext } from '../application/inbox-digest'
import { InMemoryUpdateFeedReadStateStore } from './read-state-store'
import { DynamoDbInboxDigestStore, INBOX_DIGEST_INDEX } from './inbox-digest-store'

const recipient = { workspaceId: 'w', memberKey: 'reader' }
const now = Date.parse('2026-10-03T12:00:00Z')
const membershipKey = { workspaceId: 'w', recordKey: 'MEMBER#reader' }
const membership: PlanningCallerAuthorizationConditionCheck = { ConditionCheck: { TableName: 'members', Key: membershipKey, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': 2 } } }

/** Creates an SDK-command-boundary transactional model with atomic condition evaluation. */
async function fixture() {
  const rows = new Map<string, Record<string, unknown>>()
  const commands: unknown[] = []
  let loseResponse = false
  let loseClaimResponse = false
  let clock = now
  let readError: unknown
  let preferencesReadError: unknown
  let writeError: unknown
  let sdkFailure: ((command: unknown) => unknown) | undefined
  let beforeTransaction: (() => void) | undefined
  const indexed: Record<string, unknown>[] = []
  /** Derives model coordinates from the known table schemas. */
  const coordinate = (table: string, value: Record<string, unknown>) => JSON.stringify([table, table === 'notifications' ? value.recipientKey : value.workspaceId, table === 'notifications' ? value.notificationKey : value.recordKey])
  rows.set(coordinate('members', membershipKey), { ...membershipKey, version: 2 })
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  /** Evaluates the actual generated conjunction against the isolated row. */
  const condition = (expression: string | undefined, row: Record<string, unknown> | undefined, names: Record<string, string> = {}, values: Record<string, unknown> = {}) => {
    return expression?.split(' AND ').every((part) => {
      const absent = /^attribute_not_exists\((\w+)\)$/.exec(part)
      if (absent) return row?.[absent[1]!] === undefined
      const [path, expected] = part.split(' = ')
      let observed: unknown = row
      for (const component of (path ?? '').split('.')) {
        observed = typeof observed === 'object' && observed !== null && !Array.isArray(observed) ? Reflect.get(observed, names[component] ?? component) : undefined
      }
      return expected !== undefined && observed === values[expected]
    }) ?? true
  }
  // Only the SDK's overloaded send signature needs this test-only cast.
  client.send = (async (command: unknown) => {
    const injected = sdkFailure?.(command)
    if (injected !== undefined) throw injected
    commands.push(command)
    if (command instanceof GetCommand) {
      if (readError) throw readError
      if (preferencesReadError && command.input.TableName === 'notifications') throw preferencesReadError
      expect(command.input.ConsistentRead).toBe(true)
      return { Item: structuredClone(rows.get(coordinate(command.input.TableName!, command.input.Key!))) }
    }
    if (command instanceof QueryCommand) {
      expect(command.input.IndexName).toBe(INBOX_DIGEST_INDEX.name)
      expect(command.input.Limit).toBeLessThanOrEqual(100)
      expect(command.input.ConsistentRead).toBeUndefined()
      return { Items: indexed, LastEvaluatedKey: { workspaceId: 'next', recordKey: 'next' } }
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected SDK command')
    if (writeError) throw typeof writeError === 'function' ? writeError(command.input.TransactItems?.length ?? 0) : writeError
    beforeTransaction?.()
    const items = command.input.TransactItems ?? []
    const reasons = items.map((item) => {
      const operation = item.Put ?? item.ConditionCheck
      if (!operation?.TableName) throw new Error('Missing transaction operation')
      const value = 'Item' in operation ? operation.Item : operation.Key
      if (!value) throw new Error('Missing transaction coordinates')
      return { Code: condition(operation.ConditionExpression, rows.get(coordinate(operation.TableName, value)), operation.ExpressionAttributeNames, operation.ExpressionAttributeValues) ? 'None' : 'ConditionalCheckFailed' }
    })
    if (reasons.some((reason) => reason.Code !== 'None')) throw Object.assign(new Error('Conditional failure'), { name: 'TransactionCanceledException', CancellationReasons: reasons })
    // Evaluate every condition first; apply all writes without an await boundary.
    for (const item of items) if (item.Put?.Item && item.Put.TableName) rows.set(coordinate(item.Put.TableName, item.Put.Item), structuredClone(item.Put.Item))
    if (loseClaimResponse) { loseClaimResponse = false; throw Object.assign(new Error('Lost claim response'), { name: 'TimeoutError' }) }
    if (loseResponse && items.some((item) => item.Put?.TableName === 'notifications')) throw Object.assign(new Error('Lost response'), { name: 'TimeoutError' })
    return {}
  }) as DynamoDBDocumentClient['send']
  const store = new DynamoDbInboxDigestStore('planning', 'notifications', client, [membership], () => clock, 'ja')
  await store.replace('w', 'reader', { ...emptyDigestState(), preferences: { enabled: true, frequency: 'daily', views: ['recent', 'at-risk'] } })
  const snapshot = await new InMemoryPlanningClient().get('w', { workItems: [] })
  snapshot.updateTargets = [{ target: { type: 'project', teamId: 'team', projectId: 'project' }, latestVersion: 1, updateState: 'current', updatedAt: new Date(now).toISOString(), latestUpdate: { id: 'report', version: 1, health: 'at-risk', risk: 'none', summary: 'Private content', authorMemberKey: 'reader', coveredDueAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), progressSnapshot: { percent: 20, linkedWorkItemCount: 1 }, capturedScope: { teamId: 'team', projectId: 'project' } } }]
  const context: InboxDigestContext = { recipient, authorizationRevision: 0, store, readState: new InMemoryUpdateFeedReadStateStore(), reader: { memberKey: 'reader', readSnapshot: async () => snapshot, authorizeTarget: async (target: typeof snapshot.updateTargets[number]) => target } }
  return {
    store, rows, indexed, commands, coordinate, context,
    run: () => deliverInboxDigest({ authorize: async () => context }, recipient, clock),
    /** Injects a condition-boundary race. */
    beforeTransaction(callback: () => void) { beforeTransaction = callback },
    /** Loses only completion acknowledgements after both durable rows commit. */
    loseResponse() { loseResponse = true },
    /** Loses a committed claim response without running the completion path. */
    loseClaimResponse() { loseClaimResponse = true },
    /** Advances the trusted clock for lease and cadence tests. */
    advance(milliseconds: number) { clock += milliseconds },
    /** Injects a read-only SDK failure. */
    failRead(error: unknown) { readError = error },
    /** Fails only the post-claim notification preference read. */
    failPreferencesRead(error: unknown) { preferencesReadError = error },
    /** Injects a transaction SDK failure or a size-aware cancellation vector. */
    failWrite(error: unknown) { writeError = error },
    /** Injects an error at any one SDK boundary without altering stored rows. */
    failCommand(failure: (command: unknown) => unknown) { sdkFailure = failure },
    /** Inspects notification rows separately from metadata and preferences. */
    notifications: () => [...rows.values()].filter((row) => row.itemType === 'notification'),
    /** Inspects the separate delivery metadata. */
    metadata: () => [...rows.values()].find((row) => row.entryType === 'update-feed-inbox-digest')!,
  }
}

test('atomic SDK completion binds authorization, missing META, preferences and deterministic Inbox insertion', async () => {
  const f = await fixture()
  expect(await f.run()).toBe('delivered')
  expect(f.notifications()).toHaveLength(1)
  const transaction = f.commands.filter((command) => command instanceof TransactWriteCommand).at(-1)
  if (!(transaction instanceof TransactWriteCommand)) throw new Error('Missing transaction')
  expect(transaction.input.TransactItems).toHaveLength(5)
  expect(transaction.input.TransactItems?.[2]?.ConditionCheck).toMatchObject({ Key: { workspaceId: 'FENCE#w', recordKey: 'META' }, ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' })
  expect(toNotificationItem(f.notifications()[0], createNotificationRecipientKey('w', 'reader'), new Date(now))).toMatchObject({ title: '更新ダイジェストを確認できます', state: 'unread' })
  expect(JSON.stringify(f.notifications())).not.toContain('Private content')
  expect(f.metadata().inboxDigestDueAt).toBe(Date.parse('2026-10-04T00:00:00Z'))
  expect(await f.run()).toBe('not-due')
})

test('lost transaction response and concurrent attempts preserve a single durable Inbox row', async () => {
  const f = await fixture()
  f.loseResponse()
  await expect(f.run()).rejects.toMatchObject({ status: 503 })
  expect(f.notifications()).toHaveLength(1)
  const row = f.notifications()[0]!
  row.inboxState = 'archived'
  expect(await f.run()).toBe('not-due')
  expect(f.notifications()[0]?.inboxState).toBe('archived')
  const g = await fixture()
  await Promise.allSettled([g.run(), g.run()])
  expect(g.notifications()).toHaveLength(1)
  expect((await g.store.get('w', 'reader')).history[0]?.status).toBe('completed')
})

test('membership revocation or first Planning creation rolls back both completion writes', async () => {
  for (const boundary of ['membership', 'planning']) {
    const f = await fixture()
    f.beforeTransaction(() => {
      const transaction = f.commands.at(-1)
      if (!(transaction instanceof TransactWriteCommand) || !transaction.input.TransactItems?.some((item) => item.Put?.TableName === 'notifications')) return
      if (boundary === 'membership') f.rows.set(f.coordinate('members', membershipKey), { ...membershipKey, version: 3 })
      else f.rows.set(f.coordinate('planning', { workspaceId: 'FENCE#w', recordKey: 'META' }), { workspaceId: 'FENCE#w', recordKey: 'META', entryType: 'planning-meta', schemaVersion: 1, revision: 1 })
    })
    await expect(f.run()).rejects.toMatchObject({ status: 409 })
    expect(f.notifications()).toHaveLength(0)
    expect((await f.store.get('w', 'reader')).history[0]?.status).not.toBe('completed')
  }
})

test('lost claim response stays leased then reclaims once; disabled settings fence pending completion', async () => {
  const f = await fixture()
  f.loseClaimResponse()
  await expect(f.run()).rejects.toMatchObject({ status: 503 })
  expect(await f.run()).toBe('not-due')
  expect(f.notifications()).toHaveLength(0)
  expect(f.metadata().inboxDigestDueAt).toBe(now + 60_000)
  f.advance(60_001)
  expect(await f.run()).toBe('delivered')
  expect((await f.store.get('w', 'reader')).history[0]?.attempts).toBe(2)
  const g = await fixture()
  g.beforeTransaction(() => {
    const command = g.commands.at(-1)
    if (!(command instanceof TransactWriteCommand) || !command.input.TransactItems?.some((item) => item.Put?.TableName === 'notifications')) return
    const row = g.metadata()
    row.revision = Number(row.revision) + 1
    row.preferences = { enabled: false, frequency: 'daily', views: ['recent'] }
    delete row.inboxDigestShard
    delete row.inboxDigestDueAt
  })
  await expect(g.run()).rejects.toMatchObject({ status: 409 })
  expect(g.notifications()).toHaveLength(0)
  expect(await g.run()).toBe('disabled')
})

test('concurrent Inbox preference creation is fenced and a retry cannot deliver after channel disable', async () => {
  const f = await fixture()
  f.beforeTransaction(() => {
    const transaction = f.commands.at(-1)
    if (!(transaction instanceof TransactWriteCommand) || !transaction.input.TransactItems?.some((item) => item.Put?.TableName === 'notifications')) return
    const row = { recipientKey: 'w#reader', notificationKey: NOTIFICATION_PREFERENCES_KEY, itemType: 'preferences', version: 1, channels: { inApp: false, email: false, push: false, slack: false }, frequency: 'instant', quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: 'UTC' } }
    f.rows.set(f.coordinate('notifications', row), row)
  })
  await expect(f.run()).rejects.toMatchObject({ status: 409 })
  await expect(f.run()).rejects.toMatchObject({ status: 409 })
  expect(f.notifications()).toHaveLength(0)
})

for (const boundary of ['metadata', 'preferences', 'query', 'second-candidate', 'write']) for (const [name, status, code] of [
  ['TimeoutError', 503, 'UpdateFeedDigestRetryable'],
  ['AccessDeniedException', 502, 'UpdateFeedDigestStoragePermanent'],
  ['UnclassifiedNetworkFailure', 502, 'UpdateFeedDigestStorageFailure'],
] as const) test(`${boundary} SDK ${name} is classified without partial success`, async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  const row = f.metadata()
  const shard = Number(String(row.inboxDigestShard).split('#')[1])
  f.indexed.push({ workspaceId: row.workspaceId, recordKey: row.recordKey }, { workspaceId: row.workspaceId, recordKey: row.recordKey })
  let reads = 0
  f.failCommand((command) => {
    const fails = boundary === 'write' ? command instanceof TransactWriteCommand : boundary === 'query' ? command instanceof QueryCommand : command instanceof GetCommand && (boundary === 'preferences' ? command.input.TableName === 'notifications' : boundary === 'second-candidate' ? ++reads === 2 : true)
    return fails ? Object.assign(new Error('Sensitive SDK detail'), { name }) : undefined
  })
  let deliveries = 0
  const operation = boundary === 'metadata' ? f.store.get('w', 'reader') : boundary === 'preferences' ? f.run() : boundary === 'write' ? f.store.replace('w', 'reader', state) : runInboxDigestSchedule({ enabled: true, listCandidates: async () => { const page = await f.store.listDue(shard); return { recipients: page.recipients, cursor: JSON.stringify(page.cursor) } }, dependencies: { authorize: async () => { deliveries++; return f.context } } }, now)
  await expect(operation).rejects.toMatchObject({ status, code })
  expect(f.notifications()).toHaveLength(0)
  expect(deliveries).toBe(0)
  if (boundary === 'second-candidate') expect(reads).toBe(2)
})

for (const malformed of ['index-key', 'owner', 'state']) test(`due candidate ${malformed} corruption is typed and returns no page`, async () => {
  const f = await fixture()
  const row = f.metadata()
  const shard = Number(String(row.inboxDigestShard).split('#')[1])
  f.indexed.push({ workspaceId: row.workspaceId, recordKey: malformed === 'index-key' ? 'wrong' : row.recordKey })
  if (malformed === 'owner') row.memberKey = ''
  if (malformed === 'state') row.history = 'invalid'
  await expect(f.store.listDue(shard)).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState' })
  expect(f.notifications()).toHaveLength(0)
})

test('due query is bounded and rechecks stale index entries against strongly consistent canonical metadata', async () => {
  const f = await fixture()
  const row = f.metadata()
  f.indexed.push({ workspaceId: row.workspaceId, recordKey: row.recordKey })
  const shard = Number(String(row.inboxDigestShard).split('#')[1])
  expect(await f.store.listDue(shard, 10)).toEqual({ recipients: [{ ...recipient, frequency: 'daily' }], cursor: { workspaceId: 'next', recordKey: 'next' } })
  await f.run()
  expect((await f.store.listDue(shard, 10)).recipients).toEqual([])
  const state = await f.store.get('w', 'reader')
  await f.store.replace('w', 'reader', { ...state, preferences: { ...state.preferences, enabled: false } })
  expect(f.metadata().inboxDigestShard).toBeUndefined()
  expect((await f.store.listDue(shard, 10)).recipients).toEqual([])
  await expect(f.store.listDue(shard, 101)).rejects.toMatchObject({ status: 409 })
  expect((await f.store.get('other', 'reader')).preferences.enabled).toBe(false)
})

test('malformed due rows fail closed and metadata cannot bypass the atomic completion path', async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  await expect(f.store.replace('w', 'reader', { ...state, history: [{ id: 'daily:2026-10-03', status: 'completed', attempts: 1, token: 'forged', leaseUntil: 0, count: 1 }] })).rejects.toMatchObject({ status: 409 })
  f.metadata().inboxDigestDueAt = 'malformed'
  await expect(f.store.get('w', 'reader')).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState' })
  expect(f.notifications()).toHaveLength(0)
})

for (const frequency of ['daily', 'weekly'] as const) for (const empty of [false, true]) test(`${frequency} claim completes across Monday midnight with empty=${empty}`, async () => {
  const f = await fixture()
  const start = Date.parse('2026-10-04T23:59:50Z')
  f.advance(start - now)
  const state = await f.store.get('w', 'reader')
  await f.store.replace('w', 'reader', { ...state, preferences: { enabled: true, frequency, views: ['recent'] } })
  if (empty) f.context.reader.authorizeTarget = async () => undefined
  const read = f.context.reader.readSnapshot
  let crossed = false
  f.context.reader.readSnapshot = async () => { if (!crossed) { crossed = true; f.advance(20_000) }; return read() }
  expect(await f.run()).toBe(empty ? 'empty' : 'delivered')
  const id = `${frequency}:${frequency === 'daily' ? '2026-10-04' : '2026-09-28'}`
  expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ id, status: 'completed', attempts: 1 })
  expect(f.notifications()).toHaveLength(empty ? 0 : 1)
  expect(f.metadata().inboxDigestDueAt).toBe(start + 20_000)
  expect(await f.run()).toBe(empty ? 'empty' : 'delivered')
  expect((await f.store.get('w', 'reader')).history).toHaveLength(2)
  expect(f.notifications()).toHaveLength(empty ? 0 : 2)
})

test('completion preserves prior history and rejects forged or multiple transitions and expired claims', async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  const claimed = await f.store.replace('w', 'reader', { ...state, history: [
    { id: 'daily:2026-10-02', status: 'failed', attempts: 1, token: 'older', leaseUntil: 0, count: 0 },
    { id: 'daily:2026-10-03', status: 'pending', attempts: 1, token: 'claim', leaseUntil: now + 60_000, count: 0 },
  ] })
  const completed = { ...claimed, history: claimed.history.map((row) => row.id === 'daily:2026-10-03' ? { ...row, status: 'completed' as const, leaseUntil: 0 } : row) }
  const forged = structuredClone(completed)
  forged.history[1]!.token = 'forged'
  await expect(f.store.complete(recipient, forged, 0, undefined)).rejects.toMatchObject({ status: 409 })
  const changedTime = structuredClone(completed)
  changedTime.history[1]!.startedAt = now - 1
  await expect(f.store.complete(recipient, changedTime, 0, undefined)).rejects.toMatchObject({ status: 409 })
  const multiple = structuredClone(completed)
  multiple.history[0]!.status = 'completed'
  await expect(f.store.complete(recipient, multiple, 0, undefined)).rejects.toMatchObject({ status: 409 })
  const saved = await f.store.complete(recipient, completed, 0, undefined)
  expect(saved.history[0]).toEqual(claimed.history[0])
  const g = await fixture()
  const pending = await g.store.replace('w', 'reader', { ...await g.store.get('w', 'reader'), history: [claimed.history[1]!] })
  g.advance(60_001)
  await expect(g.store.complete(recipient, { ...pending, history: completed.history.slice(1) }, 0, undefined)).rejects.toMatchObject({ status: 409 })
  expect(g.notifications()).toHaveLength(0)
})

test('completion rejects a logical interval later than its real first claim', async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  const claimed = await f.store.replace('w', 'reader', { ...state, history: [{ id: 'daily:2026-10-04', status: 'pending', attempts: 1, token: 'claim', startedAt: now, leaseUntil: now + 60_000, count: 0 }] })
  await expect(f.store.complete(recipient, { ...claimed, history: claimed.history.map((row) => ({ ...row, status: 'completed', leaseUntil: 0 })) }, 0, undefined)).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  expect(f.notifications()).toHaveLength(0)
})

test('read failures distinguish absent, transient SDK and corrupt persisted envelopes/preferences/receipts/due fields', async () => {
  const f = await fixture()
  expect(await f.store.get('missing', 'reader')).toEqual(emptyDigestState())
  for (const name of ['ThrottlingException', 'TimeoutError', 'ProvisionedThroughputExceededException']) {
    f.failRead(Object.assign(new Error('private SDK detail'), { name }))
    await expect(f.store.get('w', 'reader')).rejects.toMatchObject({ status: 503, code: 'UpdateFeedDigestRetryable' })
  }
  f.failRead(new Error('unknown private failure'))
  await expect(f.store.get('w', 'reader')).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestStorageFailure' })
  f.failRead(undefined)
  const original = structuredClone(f.metadata())
  for (const mutation of [{ schemaVersion: 2 }, { memberKey: 'other' }, { preferences: { enabled: true } }, { history: [{}] }, { history: [{ id: 'daily:2026-10-03', status: 'failed', attempts: 1, token: 'claim', leaseUntil: 0, count: 0, startedAt: -1 }] }, { inboxDigestShard: 'wrong' }, { inboxDigestDueAt: 'invalid' }]) {
    f.rows.set(f.coordinate('planning', original), { ...original, ...mutation })
    await expect(f.store.get('w', 'reader')).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState' })
  }
  f.rows.set(f.coordinate('planning', original), original)
  await expect(f.store.replace('w', 'reader', { ...emptyDigestState(), revision: -1 })).rejects.toMatchObject({ status: 400 })
  await expect(f.store.replace('w', 'reader', emptyDigestState())).rejects.toMatchObject({ status: 409 })
})

test('late-week delivery uses first claim time for sorting and full retention, stable across retry and lost response', async () => {
  const f = await fixture()
  await f.store.replace('w', 'reader', { ...await f.store.get('w', 'reader'), preferences: { enabled: true, frequency: 'weekly', views: ['recent'] } })
  const read = f.context.reader.readSnapshot
  let fail = true
  f.context.reader.readSnapshot = async () => { if (fail) throw new Error('Transient content read'); return read() }
  await expect(f.run()).rejects.toThrow('Transient content read')
  expect((await f.store.get('w', 'reader')).history[0]?.startedAt).toBe(now)
  f.advance(60_000)
  fail = false
  f.loseResponse()
  await expect(f.run()).rejects.toMatchObject({ status: 503, code: 'UpdateFeedDigestRetryable' })
  const notification = f.notifications()[0]!
  expect(notification.eventId).toBe('update-feed-digest:weekly:2026-09-28')
  expect(notification.occurredAt).toBe(new Date(now).toISOString())
  expect(notification.createdAt).toBe(new Date(now).toISOString())
  expect(notification.expiresAt).toBe(now / 1000 + 365 * 86400)
  expect(String(notification.notificationKey) > '2026-10-02T23:59:00.000Z#ordinary-notification').toBe(true)
  const key = notification.notificationKey
  f.advance(60_000)
  expect(await f.run()).toBe('not-due')
  expect(f.notifications()).toHaveLength(1)
  expect(f.notifications()[0]?.notificationKey).toBe(key)
})

for (const [name, code, terminal] of [
  ['TimeoutError', 'UpdateFeedDigestRetryable', undefined],
  ['AccessDeniedException', 'UpdateFeedDigestStoragePermanent', 'storage-permanent'],
  ['NetworkingError', 'UpdateFeedDigestStorageFailure', undefined],
] as const) test(`post-claim preference read classifies ${name} without committing a notification`, async () => {
  const f = await fixture()
  f.failPreferencesRead(Object.assign(new Error('private SDK detail'), { name }))
  try { await f.run(); throw new Error('Expected rejection') }
  catch (error) { expect(error).toMatchObject({ code }); expect(inboxDigestTerminalReason(error)).toBe(terminal); expect(String(error)).not.toContain('private SDK') }
  expect(f.notifications()).toHaveLength(0)
  expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ status: 'failed', attempts: 1 })
  f.failPreferencesRead(undefined)
  f.advance(60_000)
  expect(await f.run()).toBe('delivered')
  expect(f.notifications()).toHaveLength(1)
})

test('malformed notification preferences are corruption while absent consent defaults and explicit opt-out stays conflict', async () => {
  const owner = createNotificationRecipientKey('w', 'reader')
  const key = { recipientKey: owner, notificationKey: NOTIFICATION_PREFERENCES_KEY }
  const valid = { ...key, itemType: 'preferences', version: 1, channels: { inApp: true, email: false, push: false, slack: false }, frequency: 'instant', quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: 'UTC' } }
  for (const bad of [{ ...valid, recipientKey: 'other' }, { ...valid, notificationKey: 'other' }, { ...valid, itemType: 'wrong' }, { ...valid, channels: { inApp: 'true' } }]) {
    const f = await fixture()
    f.rows.set(f.coordinate('notifications', key), bad)
    await expect(f.run()).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState' })
    expect(f.notifications()).toHaveLength(0)
  }
  const off = await fixture()
  off.rows.set(off.coordinate('notifications', key), { ...valid, channels: { ...valid.channels, inApp: false } })
  await expect(off.run()).rejects.toMatchObject({ status: 409, code: 'UpdateFeedDigestConflict' })
  expect(off.notifications()).toHaveLength(0)
  expect(await (await fixture()).run()).toBe('delivered')
})

for (const frequency of ['daily', 'weekly'] as const) for (const boundary of [false, true]) test(`lost third ${frequency} claim recovers with boundary=${boundary}`, async () => {
  const f = await fixture()
  const start = boundary ? Date.parse('2026-10-04T23:59:30Z') : now
  f.advance(start - now)
  const id = `${frequency}:${frequency === 'weekly' ? '2026-09-28' : boundary ? '2026-10-04' : '2026-10-03'}`
  const state = await f.store.get('w', 'reader')
  await f.store.replace('w', 'reader', { ...state, preferences: { enabled: true, frequency, views: ['recent'] }, history: [{ id, status: 'failed', attempts: 2, token: 'previous', leaseUntil: 0, startedAt: start - 60_000, count: 0 }] })
  f.loseClaimResponse()
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestRetryable' })
  expect(f.metadata().inboxDigestDueAt).toBe(start + 60_000)
  expect((await f.store.get('w', 'reader')).history[0]).toMatchObject({ id, status: 'pending', attempts: 3 })
  expect(await f.run()).toBe('not-due')
  f.advance(60_001)
  f.indexed.push(structuredClone(f.metadata()))
  const shard = Number(String(f.metadata().inboxDigestShard).split('#')[1])
  expect((await f.store.listDue(shard)).recipients).toEqual([{ ...recipient, frequency }])
  if (boundary) expect(await deliverInboxDigest({ authorize: async () => f.context }, recipient, start + 60_001, start, frequency)).toBe('delivered')
  else await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestAttemptsExhausted' })
  expect((await f.store.get('w', 'reader')).history.find((row) => row.id === id)).toMatchObject({ status: 'failed', attempts: 3, leaseUntil: 0 })
  expect(f.notifications()).toHaveLength(boundary ? 1 : 0)
  if (boundary) { expect(await f.run()).toBe('not-due'); expect(f.notifications()).toHaveLength(1) }
  else expect(f.metadata().inboxDigestDueAt).toBe(Date.parse(frequency === 'daily' ? '2026-10-04T00:00:00Z' : '2026-10-05T00:00:00Z'))
})

for (const frequency of ['daily', 'weekly'] as const) test(`delayed first ${frequency} claim keeps logical interval but orders and expires from actual claim time`, async () => {
  const f = await fixture()
  const scheduledAt = Date.parse('2026-10-04T23:59:30Z')
  const retryAt = scheduledAt + 120_000
  f.advance(scheduledAt - now)
  const state = await f.store.get('w', 'reader')
  await f.store.replace('w', 'reader', { ...state, preferences: { enabled: true, frequency, views: ['recent'] } })
  f.failWrite(Object.assign(new Error('Claim transport failure'), { name: 'TimeoutError' }))
  await expect(deliverInboxDigest({ authorize: async () => f.context }, recipient, scheduledAt, scheduledAt, frequency)).rejects.toMatchObject({ code: 'UpdateFeedDigestRetryable' })
  expect((await f.store.get('w', 'reader')).history).toEqual([])
  f.failWrite(undefined)
  f.advance(retryAt - scheduledAt)
  expect(await deliverInboxDigest({ authorize: async () => f.context }, recipient, retryAt, scheduledAt, frequency)).toBe('delivered')
  expect((await f.store.get('w', 'reader')).history).toMatchObject([{ startedAt: retryAt, status: 'completed', id: `${frequency}:${frequency === 'daily' ? '2026-10-04' : '2026-09-28'}` }])
  expect(f.notifications()[0]).toMatchObject({ occurredAt: new Date(retryAt).toISOString(), expiresAt: Math.floor(retryAt / 1000) + 365 * 86_400 })
  expect(await deliverInboxDigest({ authorize: async () => f.context }, recipient, retryAt + 1, scheduledAt, frequency)).toBe('not-due')
  expect(f.notifications()).toHaveLength(1)
})

test('a pinned retry defers a live prior claim instead of acknowledging unfinished logical work', async () => {
  const f = await fixture()
  f.loseClaimResponse()
  await expect(f.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestRetryable' })
  f.advance(30_000)
  await expect(deliverInboxDigest({ authorize: async () => f.context }, recipient, now + 30_000, now, 'daily')).rejects.toMatchObject({ code: 'UpdateFeedDigestConflict' })
  f.advance(30_001)
  expect(await deliverInboxDigest({ authorize: async () => f.context }, recipient, now + 60_001, now, 'daily')).toBe('delivered')
  expect((await f.store.get('w', 'reader')).history).toMatchObject([{ attempts: 2, startedAt: now, status: 'completed' }])
  expect(f.notifications()).toHaveLength(1)
})

test('transaction failures classify complete cancellation vectors and permanent SDK failures without leaking details', async () => {
  const f = await fixture()
  const state = await f.store.get('w', 'reader')
  for (const name of ['ValidationException', 'AccessDeniedException', 'ResourceNotFoundException']) {
    f.failWrite(Object.assign(new Error('private SDK detail'), { name }))
    try { await f.store.replace('w', 'reader', state); throw new Error('Expected rejection') }
    catch (error) {
      expect(error).toMatchObject({ status: 502, code: 'UpdateFeedDigestStoragePermanent' })
      expect(inboxDigestTerminalReason(error)).toBe('storage-permanent')
      expect(String(error)).not.toContain('private SDK')
    }
  }
  f.failWrite(new Error('Unknown network failure'))
  await expect(f.store.replace('w', 'reader', state)).rejects.toMatchObject({ status: 502, code: 'UpdateFeedDigestStorageFailure' })
  for (const name of ['ThrottlingException', 'TimeoutError', 'TransactionInProgressException', 'InternalServerError']) {
    f.failWrite(Object.assign(new Error('temporary'), { name }))
    await expect(f.store.replace('w', 'reader', state)).rejects.toMatchObject({ status: 503, code: 'UpdateFeedDigestRetryable' })
  }
  for (const [codes, status] of [
    [['None', 'ConditionalCheckFailed'], 409], [['None', 'TransactionConflict'], 503],
    [['ConditionalCheckFailed', 'ThrottlingError'], 503], [['ValidationError', 'TransactionConflict'], 502],
    [['None'], 502], [['None', 'None'], 502], [['None', undefined], 502],
  ] as const) {
    f.failWrite({ name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) })
    await expect(f.store.replace('w', 'reader', state)).rejects.toMatchObject({ status })
  }
  expect(await f.store.get('w', 'reader')).toEqual(state)
  expect(f.notifications()).toHaveLength(0)
})
