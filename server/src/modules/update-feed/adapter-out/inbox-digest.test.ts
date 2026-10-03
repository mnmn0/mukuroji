import { expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import type { UpdateFeedDigestState, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { PlanningError } from '../../planning'
import { createNotificationRecipientKey, toNotificationItem } from '../../notifications'
import { InMemoryUpdateFeedDigestStore } from './digest-store'
import { DynamoDbUpdateFeedReadStateStore, InMemoryUpdateFeedReadStateStore } from './read-state-store'
import { createInboxDigestNotification } from './inbox-digest-notification'
import { deliverInboxDigest, inboxDigestTerminalReason, runInboxDigestSchedule, type InboxDigestDependencies, type InboxDigestMessage, type InboxDigestStore } from '../application/inbox-digest'
import type { UpdateFeedReader } from '../application/read-update-feed'
import { createInboxDigestScheduleHandler } from '../adapter-in/schedules/inbox-digest-schedule'

const now = Date.parse('2026-10-03T12:00:00Z')
const recipient = { workspaceId: 'workspace', memberKey: 'reader' }
const candidate = { ...recipient, frequency: 'daily' as const }

/** Isolated transaction-boundary model; never touches live storage or notifications. */
async function fixture(count = 1) {
  const metadata = new InMemoryUpdateFeedDigestStore()
  const readState = new InMemoryUpdateFeedReadStateStore()
  const inbox = new Map<string, ReturnType<typeof createInboxDigestNotification>>()
  let authorized = true
  let fail = false
  let loseResponse = false
  let beforeComplete: (() => Promise<void>) | undefined
  const initial = await metadata.get(recipient.workspaceId, recipient.memberKey)
  await metadata.replace(recipient.workspaceId, recipient.memberKey, { ...initial, preferences: { enabled: true, frequency: 'daily', views: ['recent', 'at-risk'] } })
  const snapshot = await new InMemoryPlanningClient().get(recipient.workspaceId, { workItems: [] })
  snapshot.updateTargets = Array.from({ length: count }, (_, index): PlanningUpdateTargetSummary => ({
    target: { type: 'project', teamId: 'team', projectId: `project-${index}` },
    latestVersion: 1, updateState: 'current', updatedAt: new Date(now).toISOString(),
    latestUpdate: { id: `report-${index}`, version: 1, health: 'at-risk', risk: 'none', summary: 'Private report', authorMemberKey: 'reader', coveredDueAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), progressSnapshot: { percent: 20, linkedWorkItemCount: 2 }, capturedScope: { teamId: 'team', projectId: `project-${index}` } },
  }))
  const reader: UpdateFeedReader = { memberKey: recipient.memberKey, readSnapshot: async () => snapshot, authorizeTarget: async (target) => authorized ? target : undefined }
  const store: InboxDigestStore = {
    get: (workspaceId, memberKey) => metadata.get(workspaceId, memberKey),
    replace: (workspaceId, memberKey, state) => metadata.replace(workspaceId, memberKey, state),
    complete: async (owner, state, revision, message) => {
      await beforeComplete?.()
      if (!authorized || revision !== snapshot.revision || fail) throw new Error('Transaction rejected')
      const row = message ? createInboxDigestNotification(owner, message) : undefined
      // The in-memory CAS settles synchronously; no awaited side effect can split
      // the durable row and receipt. Production must use a single transaction.
      const saved = await metadata.replace(owner.workspaceId, owner.memberKey, state)
      if (row && !inbox.has(row.notificationKey)) inbox.set(row.notificationKey, row)
      if (loseResponse) throw new Error('Response lost after atomic commit')
      return saved
    },
  }
  const dependencies: InboxDigestDependencies = { authorize: async () => authorized ? { recipient, authorizationRevision: snapshot.revision, reader, readState, store } : undefined }
  return {
    metadata, readState, inbox, snapshot, reader, dependencies,
    run: (time = now) => deliverInboxDigest(dependencies, recipient, time),
    /** Simulates transaction-time authorization revocation. */
    revoke() { authorized = false },
    /** Simulates a rejected atomic transaction. */
    fail(value: boolean) { fail = value },
    /** Simulates a successful transaction whose acknowledgement was lost. */
    loseResponse(value: boolean) { loseResponse = value },
    /** Injects a race immediately before transaction conditions are checked. */
    beforeComplete(callback: () => Promise<void>) { beforeComplete = callback },
    /** Saves delivery-only preferences with the current revision. */
    async configure(preferences: UpdateFeedDigestState['preferences']) {
      const current = await metadata.get(recipient.workspaceId, recipient.memberKey)
      await metadata.replace(recipient.workspaceId, recipient.memberKey, { ...current, preferences })
    },
  }
}

for (const corrupt of [true, false]) test(`actual read-state adapter corruption=${corrupt} has distinct scheduler disposition`, async () => {
  const f = await fixture()
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  // Only the SDK overload is replaced; the real persisted parser classifies the row.
  client.send = (async (command: unknown) => {
    if (!(command instanceof GetCommand)) throw new Error('Unexpected SDK command')
    if (!corrupt) throw new Error('Unknown transport failure')
    return { Item: { ...command.input.Key, schemaVersion: 1, revision: 1, read: 'malformed' } }
  }) as DynamoDBDocumentClient['send']
  const readState = new DynamoDbUpdateFeedReadStateStore('planning', client)
  const result = await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [candidate] }), dependencies: { authorize: async () => {
    const context = await f.dependencies.authorize(recipient)
    if (!context) throw new Error('Fixture missing')
    return { ...context, readState }
  } } }, now)
  expect(result.failed).toEqual(corrupt ? [] : [{ ...candidate, scheduledAt: now }])
  expect(result.terminal).toEqual(corrupt ? [{ recipient, reason: 'corrupt-state' }] : [])
  expect(result.delivered).toBe(0)
  expect(f.inbox.size).toBe(0)
})

for (const sameTeam of [true, false]) test(`Feed duplicate classification uses Team-qualified identity: same Team ${sameTeam}`, async () => {
  const f = await fixture()
  const first = f.snapshot.updateTargets[0]
  if (!first) throw new Error('Fixture missing')
  const second = structuredClone(first)
  if (!sameTeam && second.target.type === 'project') second.target.teamId = 'other-team'
  f.snapshot.updateTargets.push(second)
  const result = await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [candidate] }), dependencies: f.dependencies }, now)
  expect(result).toMatchObject({ processed: 1, delivered: sameTeam ? 0 : 1, failed: [], terminal: sameTeam ? [{ recipient, reason: 'corrupt-state' }] : [] })
  expect(f.inbox.size).toBe(sameTeam ? 0 : 1)
})

for (const frequency of ['daily', 'weekly'] as const) test(`${frequency} real future receipts preserve clock rollback protection`, async () => {
  const f = await fixture()
  await f.configure({ enabled: true, frequency, views: ['recent'] })
  expect(await f.run(now + 7 * 86_400_000)).toBe('delivered')
  expect(await f.run(now)).toBe('not-due')
  expect(f.inbox.size).toBe(1)
})

test('delivers a bodyless existing-format Inbox notification once per interval', async () => {
  const f = await fixture(60)
  expect(await f.run()).toBe('delivered')
  expect(await f.run()).toBe('not-due')
  expect(f.inbox.size).toBe(1)
  const row = [...f.inbox.values()][0]!
  expect(toNotificationItem(row, createNotificationRecipientKey(recipient.workspaceId, recipient.memberKey), new Date(now))).toMatchObject({ state: 'unread', eventType: 'update-feed.digest', deepLink: '/updates' })
  expect(JSON.stringify(row)).not.toContain('Private')
  expect(JSON.stringify(row)).not.toContain('project-')
  expect(row.deliveryChannels).toEqual(['inApp'])
  expect((await f.metadata.get(recipient.workspaceId, recipient.memberKey)).history[0]?.count).toBe(50)
  expect(await f.run(now + 86_400_000)).toBe('delivered')
  expect(f.inbox.size).toBe(2)
})

test('concurrent claims and lost completion responses do not duplicate or reset Inbox state', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([f.run(), f.run()])
  expect(results.filter((result) => result.status === 'fulfilled' && result.value === 'delivered')).toHaveLength(1)
  expect(f.inbox.size).toBe(1)
  const g = await fixture()
  g.loseResponse(true)
  await expect(g.run()).rejects.toThrow('Response lost')
  expect(g.inbox.size).toBe(1)
  const row = [...g.inbox.values()][0]!
  row.inboxState = 'archived'
  row.recipientStatusKey = `${row.recipientKey}#archived`
  g.loseResponse(false)
  expect(await g.run()).toBe('not-due')
  expect([...g.inbox.values()][0]?.inboxState).toBe('archived')
  expect((await g.metadata.get(recipient.workspaceId, recipient.memberKey)).history[0]?.status).toBe('completed')
})

test('empty/read/unauthorized targets emit no notification; current read-state and ACL win', async () => {
  const f = await fixture()
  await f.readState.set(recipient.workspaceId, recipient.memberKey, { target: f.snapshot.updateTargets[0]!.target, version: 1, read: true, expectedRevision: 0 })
  expect(await f.run()).toBe('empty')
  expect(f.inbox.size).toBe(0)
  const g = await fixture()
  g.reader.authorizeTarget = async () => undefined
  expect(await g.run()).toBe('empty')
  expect(g.inbox.size).toBe(0)
  const h = await fixture()
  h.beforeComplete(async () => h.revoke())
  await expect(h.run()).rejects.toThrow('Transaction rejected')
  expect(h.inbox.size).toBe(0)
  expect(await h.run()).toBe('denied')
})

test('disable and cadence changes fence stale delivery and weekly keys start on Monday', async () => {
  const f = await fixture()
  await f.configure({ enabled: false, frequency: 'daily', views: ['recent'] })
  expect(await f.run()).toBe('disabled')
  await f.configure({ enabled: true, frequency: 'weekly', views: ['recent'] })
  expect(await f.run()).toBe('delivered')
  expect(await f.run(now + 86_400_000)).toBe('not-due')
  expect(await f.run(Date.parse('2026-10-05T00:00:00Z'))).toBe('delivered')
  expect([...f.inbox.values()][0]?.eventId).toBe('update-feed-digest:weekly:2026-09-28')
  const g = await fixture()
  g.beforeComplete(() => g.configure({ enabled: false, frequency: 'daily', views: ['recent'] }))
  await expect(g.run()).rejects.toMatchObject({ status: 409 })
  expect(g.inbox.size).toBe(0)
})

test('rejected transactions retry with a bounded receipt and no partial notification', async () => {
  const f = await fixture()
  f.fail(true)
  await expect(f.run()).rejects.toThrow('Transaction rejected')
  expect(f.inbox.size).toBe(0)
  f.fail(false)
  expect(await f.run()).toBe('delivered')
  expect((await f.metadata.get(recipient.workspaceId, recipient.memberKey)).history[0]?.attempts).toBe(2)
  const g = await fixture()
  g.fail(true)
  for (let attempt = 0; attempt < 3; attempt++) await expect(g.run()).rejects.toThrow()
  g.fail(false)
  await expect(g.run()).rejects.toMatchObject({ code: 'UpdateFeedDigestAttemptsExhausted' })
  expect(g.inbox.size).toBe(0)
})

test('expired claims are reclaimed while an older worker cannot finalize or release the successor', async () => {
  const f = await fixture()
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const blockedReader: UpdateFeedReader = { ...f.reader, readSnapshot: async () => { started?.(); await gate; return f.snapshot } }
  const context = await f.dependencies.authorize(recipient)
  if (!context) throw new Error('Fixture authorization missing')
  const old = deliverInboxDigest({ authorize: async () => ({ ...context, reader: blockedReader }) }, recipient, now)
  await waiting
  expect(await f.run()).toBe('not-due')
  expect(await f.run(now + 60_001)).toBe('delivered')
  const saved = await f.metadata.get(recipient.workspaceId, recipient.memberKey)
  release?.()
  await expect(old).rejects.toMatchObject({ status: 409 })
  expect(await f.metadata.get(recipient.workspaceId, recipient.memberKey)).toEqual(saved)
  expect(f.inbox.size).toBe(1)
})

test('rejects mismatched recipient contexts and invalid clocks and skips rolled-back intervals', async () => {
  const f = await fixture()
  await expect(deliverInboxDigest(f.dependencies, { ...recipient, memberKey: 'other' }, now)).rejects.toThrow('Digest recipient mismatch')
  await expect(deliverInboxDigest(f.dependencies, { ...recipient, workspaceId: 'other' }, now)).rejects.toThrow('Digest recipient mismatch')
  await expect(f.run(Number.NaN)).rejects.toThrow('Invalid digest clock')
  expect(await f.run()).toBe('delivered')
  expect(await f.run(now - 86_400_000)).toBe('not-due')
  await f.configure({ enabled: true, frequency: 'weekly', views: ['recent'] })
  expect(await f.run()).toBe('delivered')
  await f.configure({ enabled: true, frequency: 'daily', views: ['recent'] })
  expect(await f.run()).toBe('not-due')
  expect(f.inbox.size).toBe(2)
})

test('a Planning change after recipient authorization invalidates the captured ACL context', async () => {
  const f = await fixture()
  const context = await f.dependencies.authorize(recipient)
  if (!context) throw new Error('Fixture authorization missing')
  f.snapshot.revision++
  await expect(deliverInboxDigest({ authorize: async () => context }, recipient, now)).rejects.toThrow('Digest authorization changed')
  expect(f.inbox.size).toBe(0)
})

test('scheduler is opt-in, bounds pages, deduplicates recipients and preserves failed checkpoints', async () => {
  const f = await fixture()
  let calls = 0
  const schedule = {
    enabled: false,
    dependencies: f.dependencies,
    listCandidates: async (_cursor: string | undefined, limit: number) => {
      calls++
      expect(limit).toBe(100)
      return { recipients: [candidate, candidate], cursor: 'next-page' }
    },
  }
  const handler = createInboxDigestScheduleHandler(schedule, () => now)
  expect(await handler()).toMatchObject({ processed: 0 })
  expect(calls).toBe(0)
  schedule.enabled = true
  f.fail(true)
  expect(await runInboxDigestSchedule(schedule, now)).toEqual({ processed: 1, delivered: 0, failed: [{ ...candidate, scheduledAt: now }], terminal: [], cursor: 'next-page' })
  f.fail(false)
  expect(await handler()).toMatchObject({ processed: 1, delivered: 1, failed: [] })
  await expect(runInboxDigestSchedule(schedule, now, 'next-page')).rejects.toThrow('Invalid digest candidate page')
  await expect(runInboxDigestSchedule({ ...schedule, listCandidates: async () => ({ recipients: Array.from({ length: 101 }, () => candidate) }) }, now)).rejects.toThrow('Invalid digest candidate page')
})

test('notification TTL is first-claim epoch seconds plus 365 days, stable for weekly retries', () => {
  for (const id of ['daily:2026-10-03', 'weekly:2026-09-28']) {
    const occurredAt = '2026-10-03T18:45:00.000Z'
    const message: InboxDigestMessage = { id: `update-feed-digest:${id}`, occurredAt, deepLink: '/updates' }
    const first = createInboxDigestNotification(recipient, message)
    expect(first.expiresAt).toBe(Date.parse(occurredAt) / 1000 + 365 * 86400)
    expect(createInboxDigestNotification(recipient, message).expiresAt).toBe(first.expiresAt)
    expect(Number.isSafeInteger(first.expiresAt)).toBe(true)
  }
})

test('scheduler separates terminal candidates from transient retries in a mixed bounded page', async () => {
  const f = await fixture()
  const owners = ['success', 'transient', 'exhausted', 'corrupt', 'mismatch', 'permanent', 'unknown', 'invalid-input'].map((workspaceId) => ({ workspaceId, memberKey: 'reader' }))
  const result = await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [...owners, owners[0]!].map((owner) => ({ ...owner, frequency: 'daily' as const })), cursor: 'next' }), dependencies: { authorize: async (owner) => {
    if (owner.workspaceId === 'transient') throw new PlanningError(503, 'UpdateFeedDigestRetryable', 'Unavailable')
    if (owner.workspaceId === 'exhausted') throw new PlanningError(409, 'UpdateFeedDigestAttemptsExhausted', 'Exhausted')
    if (owner.workspaceId === 'corrupt') throw new PlanningError(502, 'UpdateFeedDigestCorruptState', 'Invalid state')
    if (owner.workspaceId === 'permanent') throw new PlanningError(502, 'UpdateFeedDigestStoragePermanent', 'Configuration failure')
    if (owner.workspaceId === 'unknown') throw new PlanningError(502, 'UpdateFeedDigestStorageFailure', 'Unknown SDK failure')
    if (owner.workspaceId === 'invalid-input') throw new PlanningError(400, 'UpdateFeedDigestInvalid', 'Input is not persisted corruption')
    const context = await f.dependencies.authorize(recipient)
    if (!context) throw new Error('Fixture missing')
    if (owner.workspaceId === 'mismatch') return context
    return { ...context, recipient: owner, store: { ...context.store, get: () => context.store.get(recipient.workspaceId, recipient.memberKey), replace: (_workspaceId, memberKey, state) => context.store.replace(recipient.workspaceId, memberKey, state), complete: (_owner, state, revision, message) => context.store.complete(recipient, state, revision, message) } }
  } } }, now)
  expect(result).toEqual({ processed: 8, delivered: 1, failed: [owners[1], owners[6]].map((owner) => ({ ...owner, frequency: 'daily', scheduledAt: now })), terminal: [{ recipient: owners[2], reason: 'exhausted' }, { recipient: owners[3], reason: 'corrupt-state' }, { recipient: owners[4], reason: 'recipient-mismatch' }, { recipient: owners[5], reason: 'storage-permanent' }, { recipient: owners[7], reason: 'invalid-input' }], cursor: 'next' })
})

for (const invalid of ['limit', 'signals']) test(`real Feed ${invalid} invariant is terminal without scheduler retry`, async () => {
  const f = await fixture(invalid === 'limit' ? 2001 : 1)
  f.reader.expandedSignals = true
  f.reader.readSignals = async () => [{ target: { type: 'project', teamId: 'other', projectId: 'not-authorized' }, projectMember: false, watching: false }]
  const result = await runInboxDigestSchedule({ enabled: true, dependencies: f.dependencies, listCandidates: async () => ({ recipients: [candidate] }) }, now)
  expect(result).toMatchObject({ delivered: 0, failed: [], terminal: [{ recipient, reason: invalid === 'limit' ? 'invalid-input' : 'corrupt-state' }] })
  expect(f.inbox.size).toBe(0)
})

for (const beforeClaim of [true, false]) test(`cadence change cancels a pinned retry beforeClaim=${beforeClaim} without backdating the new cadence`, async () => {
  const f = await fixture()
  const scheduledAt = Date.parse('2026-10-04T23:59:30Z')
  f.fail(!beforeClaim)
  const first = await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [candidate] }), dependencies: beforeClaim ? { authorize: async () => { throw new Error('Unavailable') } } : f.dependencies }, scheduledAt)
  expect(first.failed).toEqual([{ ...candidate, scheduledAt }])
  f.fail(false)
  await f.configure({ enabled: true, frequency: 'weekly', views: ['recent'] })
  const retryAt = scheduledAt + 120_000
  expect(await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: first.failed }), dependencies: f.dependencies }, retryAt)).toMatchObject({ delivered: 0, failed: [], terminal: [] })
  expect(f.inbox.size).toBe(0)
  expect((await f.metadata.get(recipient.workspaceId, recipient.memberKey)).history.some((row) => row.id === 'weekly:2026-09-28')).toBe(false)
  expect(await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [{ ...recipient, frequency: 'weekly' }] }), dependencies: f.dependencies }, retryAt)).toMatchObject({ delivered: 1 })
  expect((await f.metadata.get(recipient.workspaceId, recipient.memberKey)).history.at(-1)?.id).toBe('weekly:2026-10-05')
})

test('unreachable validated-query invariants stay terminal while unknown transport errors stay retryable', () => {
  for (const code of ['UpdateFeedReadStateLimit', 'UpdateFeedReadStateInvalid', 'UpdateFeedViewInvalid', 'UpdateFeedLimitInvalid']) expect(inboxDigestTerminalReason(new PlanningError(400, code, 'Invariant'))).toBe('invalid-input')
  expect(inboxDigestTerminalReason(new PlanningError(502, 'SavedUpdateFeedsCorruptState', 'Invalid metadata'))).toBe('corrupt-state')
  for (const code of ['SavedUpdateFeedsStorageFailure', 'SavedUpdateFeedsRetryable', 'UpdateFeedReadStateStorageFailure']) expect(inboxDigestTerminalReason(new PlanningError(502, code, 'Unknown transport'))).toBeUndefined()
})

for (const frequency of ['daily', 'weekly'] as const) for (const boundary of ['before-claim', 'failed-claim', 'lost-response']) test(`${frequency} ${boundary} retry retains its logical interval across UTC rollover with a fresh lease`, async () => {
  const f = await fixture()
  await f.configure({ enabled: true, frequency, views: ['recent'] })
  const scheduledAt = Date.parse('2026-10-04T23:59:30Z')
  let first = true
  const dependencies: InboxDigestDependencies = { authorize: async (owner) => {
    if (first && boundary === 'before-claim') { first = false; throw new Error('Temporary authorization lookup failure') }
    return f.dependencies.authorize(owner)
  } }
  if (boundary === 'failed-claim') f.fail(true)
  if (boundary === 'lost-response') f.loseResponse(true)
  const result = await runInboxDigestSchedule({ enabled: true, dependencies, listCandidates: async () => ({ recipients: [{ ...recipient, frequency }] }) }, scheduledAt)
  expect(result.failed).toEqual([{ ...recipient, frequency, scheduledAt }])
  f.fail(false); f.loseResponse(false)
  const retryAt = scheduledAt + 120_000
  f.beforeComplete(async () => {
    const state = await f.metadata.get(recipient.workspaceId, recipient.memberKey)
    expect(state.history[0]?.leaseUntil).toBe(retryAt + 60_000)
  })
  const retried = await runInboxDigestSchedule({ enabled: true, dependencies, listCandidates: async () => ({ recipients: result.failed }) }, retryAt)
  expect(retried.failed).toEqual([])
  expect(retried.delivered).toBe(boundary === 'lost-response' ? 0 : 1)
  expect(f.inbox.size).toBe(1)
  const history = (await f.metadata.get(recipient.workspaceId, recipient.memberKey)).history
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ id: `${frequency}:${frequency === 'daily' ? '2026-10-04' : '2026-09-28'}`, status: 'completed' })
})
