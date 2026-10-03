import { expect, test } from 'bun:test'
import type { UpdateFeedDigestState, PlanningUpdateTargetSummary } from '@mukuroji/contracts'
import { InMemoryPlanningClient } from '../../planning/planning'
import { PlanningError } from '../../planning'
import { createNotificationRecipientKey, toNotificationItem } from '../../notifications'
import { InMemoryUpdateFeedDigestStore } from './digest-store'
import { InMemoryUpdateFeedReadStateStore } from './read-state-store'
import { createInboxDigestNotification } from './inbox-digest-notification'
import { deliverInboxDigest, runInboxDigestSchedule, type InboxDigestDependencies, type InboxDigestMessage, type InboxDigestStore } from '../application/inbox-digest'
import type { UpdateFeedReader } from '../application/read-update-feed'
import { createInboxDigestScheduleHandler } from '../adapter-in/schedules/inbox-digest-schedule'

const now = Date.parse('2026-10-03T12:00:00Z')
const recipient = { workspaceId: 'workspace', memberKey: 'reader' }

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
      return { recipients: [recipient, recipient], cursor: 'next-page' }
    },
  }
  const handler = createInboxDigestScheduleHandler(schedule, () => now)
  expect(await handler()).toMatchObject({ processed: 0 })
  expect(calls).toBe(0)
  schedule.enabled = true
  f.fail(true)
  expect(await runInboxDigestSchedule(schedule, now)).toEqual({ processed: 1, delivered: 0, failed: [recipient], terminal: [], cursor: 'next-page' })
  f.fail(false)
  expect(await handler()).toMatchObject({ processed: 1, delivered: 1, failed: [] })
  await expect(runInboxDigestSchedule(schedule, now, 'next-page')).rejects.toThrow('Invalid digest candidate page')
  await expect(runInboxDigestSchedule({ ...schedule, listCandidates: async () => ({ recipients: Array.from({ length: 101 }, () => recipient) }) }, now)).rejects.toThrow('Invalid digest candidate page')
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
  const result = await runInboxDigestSchedule({ enabled: true, listCandidates: async () => ({ recipients: [...owners, owners[0]!], cursor: 'next' }), dependencies: { authorize: async (owner) => {
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
  expect(result).toEqual({ processed: 8, delivered: 1, failed: [owners[1], owners[6]], terminal: [{ recipient: owners[2], reason: 'exhausted' }, { recipient: owners[3], reason: 'corrupt-state' }, { recipient: owners[4], reason: 'recipient-mismatch' }, { recipient: owners[5], reason: 'storage-permanent' }, { recipient: owners[7], reason: 'invalid-input' }], cursor: 'next' })
})
