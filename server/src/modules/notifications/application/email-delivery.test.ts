import { describe, expect, test } from 'bun:test'
import { deliverDueEmailNotifications } from './email-delivery'
import type { ChannelDelivery, ChannelDeliveryDependencies, ChannelDeliveryFailure, ChannelSendResult } from './channel-delivery'
import { DEFAULT_NOTIFICATION_PREFERENCES, isEmailNotificationEligible, type NotificationPreferences } from '../notifications'

/** Creates an isolated Email queue fixture with a controllable transport outcome and preferences. */
function fixture(result: ChannelSendResult, preferences: NotificationPreferences) {
  const now = new Date('2026-09-26T12:00:00.000Z')
  const delivery: ChannelDelivery = {
    workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
    notificationKey: '2026-09-26T11:00:00.000Z#event-1', attempts: 0, version: 1,
    nextAttemptAt: now.toISOString(), expiresAt: now.getTime() / 1_000 + 3_600,
    notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created',
      reasons: ['mention'], title: 'Review', occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
  }
  const finishes: Array<{ status: string, code?: string }> = []
  const shards: string[] = []
  const failures: ChannelDeliveryFailure[] = []
  let sends = 0
  let pending = true
  const dependencies: ChannelDeliveryDependencies = {
    telemetry: { reportFailure: (failure) => { failures.push(failure) }, reportQueueHealth: () => {} },
    now: () => now, createToken: () => 'lease-1', isAuthorized: async () => true,
    send: async () => { sends += 1; return result },
    store: {
      listDue: async (shard) => {
        shards.push(shard)
        return { deliveries: shard === 'email#0' && pending ? [delivery] : [], invalidCount: 0 }
      },
      claim: async () => true, renew: async () => true, release: async () => {},
      getPreferences: async () => preferences,
      finish: async (_delivery, _token, status, _next, code) => { finishes.push({ status, code }); pending = false },
    },
  }
  return { dependencies, finishes, shards, failures, sends: () => sends }
}

const emailOn: NotificationPreferences = {
  ...DEFAULT_NOTIFICATION_PREFERENCES, version: 1, updatedAt: '2026-09-26T09:00:00.000Z',
  emailEnabledAt: '2026-09-26T10:00:00.000Z', channels: { inApp: true, email: true, push: false },
}

describe('Email notification delivery application', () => {
  test('reads only the Email queue and sends opted-in notifications', async () => {
    const f = fixture({ succeeded: true, retryable: false }, emailOn)
    expect(await deliverDueEmailNotifications(f.dependencies)).toBe(1)
    expect(f.shards.every((shard) => shard.startsWith('email#'))).toBe(true)
    expect(f.finishes).toEqual([{ status: 'sent', code: undefined }])
  })
  test('suppresses a recipient without a verified address without raising an alarm', async () => {
    const f = fixture({ succeeded: false, retryable: false, suppressed: true, code: 'EmailRecipientUnverified' }, emailOn)
    expect(await deliverDueEmailNotifications(f.dependencies)).toBe(0)
    expect(f.finishes).toEqual([{ status: 'suppressed', code: 'EmailRecipientUnverified' }])
    expect(f.failures).toEqual([])
  })
  test('suppresses events from before the current Email opt-in, after Email is turned off, or after their category is turned off for Email', async () => {
    for (const preferences of [
      { ...emailOn, emailEnabledAt: '2026-09-26T11:30:00.000Z' },
      { ...emailOn, channels: { inApp: true, email: false, push: false } },
      { ...emailOn, categoryChannels: { mention: { email: false } } },
    ] satisfies NotificationPreferences[]) {
      const f = fixture({ succeeded: true, retryable: false }, preferences)
      expect(await deliverDueEmailNotifications(f.dependencies)).toBe(0)
      expect(f.sends()).toBe(0)
      expect(f.finishes[0]?.status).toBe('suppressed')
    }
  })
  test('reports permanent provider rejection with Email failure codes and the Email failed shard', async () => {
    const f = fixture({ succeeded: false, retryable: false, code: 'EmailDeliveryRejected' }, emailOn)
    await expect(deliverDueEmailNotifications(f.dependencies)).rejects.toThrow('Email notification delivery requires attention.')
    expect(f.failures[0]).toMatchObject({ code: 'EmailDeliveryRejected', shard: expect.stringMatching(/^email-failed#\d+$/) })
  })
})

describe('Email opt-in boundary', () => {
  test('uses the activation time, falling back to the last save for preferences saved before Email transport', () => {
    expect(isEmailNotificationEligible(emailOn, '2026-09-26T09:59:59.999Z')).toBe(false)
    expect(isEmailNotificationEligible(emailOn, '2026-09-26T10:00:00.000Z')).toBe(true)
    const legacy = { ...emailOn, emailEnabledAt: undefined }
    expect(isEmailNotificationEligible(legacy, '2026-09-26T08:59:59.999Z')).toBe(false)
    expect(isEmailNotificationEligible(legacy, '2026-09-26T09:00:00.000Z')).toBe(true)
    expect(isEmailNotificationEligible({ ...legacy, updatedAt: undefined }, '2026-09-26T12:00:00.000Z')).toBe(false)
  })
})

describe('Email digest delivery', () => {
  /** Creates a queue whose first due row opens a digest with the given companions. */
  function digestFixture(companionCount: number, options: { lostRenewal?: string, suppressedKey?: string, result?: ChannelSendResult, incomplete?: boolean } = {}) {
    const f = fixture({ succeeded: true, retryable: false }, emailOn)
    const base: ChannelDelivery = {
      workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
      notificationKey: '2026-09-26T11:00:00.000Z#event-1', attempts: 0, version: 1, deliveryFrequency: 'daily',
      nextAttemptAt: '2026-09-26T12:00:00.000Z', expiresAt: Date.parse('2026-09-26T12:00:00.000Z') / 1_000 + 3_600,
      notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created',
        reasons: ['mention'], title: 'Review', occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
    }
    const companions = Array.from({ length: companionCount }, (_, index): ChannelDelivery => ({
      ...base, notificationKey: `2026-09-26T11:0${index + 1}:00.000Z#event-${index + 2}`,
      nextAttemptAt: '2026-09-27T11:00:00.000Z',
      notification: { ...base.notification, id: `notification-${index + 2}`, eventId: `event-${index + 2}`,
        occurredAt: `2026-09-26T11:0${index + 1}:00.000Z` },
    }))
    const finishes: Array<{ key: string, status: string, code?: string }> = []
    const digests: string[][] = []
    let pending = true
    const dependencies: ChannelDeliveryDependencies = {
      ...f.dependencies,
      send: async () => { throw new Error('A digest row must not be sent on its own.') },
      store: {
        ...f.dependencies.store,
        listDue: async (shard) => ({ deliveries: shard === 'email#0' && pending ? [base] : [], invalidCount: 0 }),
        renew: async (delivery) => delivery.notificationKey !== options.lostRenewal,
        finish: async (delivery, _token, status, _next, code) => { finishes.push({ key: delivery.notificationKey, status, code }); pending = false },
      },
      isAuthorized: async (delivery) => delivery.notificationKey !== options.suppressedKey,
      digest: {
        listCompanions: async () => ({ deliveries: companions, complete: options.incomplete !== true }),
        send: async (deliveries) => { digests.push(deliveries.map((delivery) => delivery.notificationKey)); return options.result ?? { succeeded: true, retryable: false } },
      },
    }
    return { dependencies, finishes, digests, companions }
  }

  test('sends one digest for every row of the recipient and marks each row sent', async () => {
    const f = digestFixture(2)
    expect(await deliverDueEmailNotifications(f.dependencies)).toBe(3)
    expect(f.digests).toHaveLength(1)
    expect(f.digests[0]).toHaveLength(3)
    expect(f.finishes.map((finish) => finish.status)).toEqual(['sent', 'sent', 'sent'])
  })
  test('leaves out a row that fails its own checks or loses its lease (released, not finished), and records the shared outcome on the rest', async () => {
    const f = digestFixture(2, { suppressedKey: '2026-09-26T11:01:00.000Z#event-2', lostRenewal: '2026-09-26T11:02:00.000Z#event-3',
      result: { succeeded: false, retryable: true, code: 'EmailRateLimited' } })
    expect(await deliverDueEmailNotifications(f.dependencies)).toBe(0)
    expect(f.digests).toEqual([['2026-09-26T11:00:00.000Z#event-1']])
    expect(f.finishes).toEqual([
      { key: '2026-09-26T11:01:00.000Z#event-2', status: 'suppressed', code: undefined },
      { key: '2026-09-26T11:00:00.000Z#event-1', status: 'pending', code: 'EmailRateLimited' },
    ])
  })
  test('sends what an incomplete companion scan found and reports the run for attention', async () => {
    const f = digestFixture(2, { incomplete: true })
    await expect(deliverDueEmailNotifications(f.dependencies)).rejects.toThrow()
    expect(f.digests).toHaveLength(1)
    expect(f.digests[0]).toHaveLength(3)
  })
  test('renews every digest row for long enough to record the shared outcome after the send', async () => {
    const f = digestFixture(2)
    const leases: Array<number | undefined> = []
    const dependencies: ChannelDeliveryDependencies = {
      ...f.dependencies,
      store: { ...f.dependencies.store, renew: async (_delivery, _token, _now, leaseMs) => { leases.push(leaseMs); return true } },
    }
    expect(await deliverDueEmailNotifications(dependencies)).toBe(3)
    expect(leases).toEqual([120_000, 120_000, 120_000])
  })
  test('hands every row back without sending when the renewals outlast the budget for the send', async () => {
    const f = digestFixture(2)
    let clock = Date.parse('2026-09-26T12:00:00.000Z')
    const released: string[] = []
    const dependencies: ChannelDeliveryDependencies = {
      ...f.dependencies,
      now: () => new Date(clock),
      store: {
        ...f.dependencies.store,
        renew: async () => { clock += 10_000; return true },
        release: async (delivery) => { released.push(delivery.notificationKey) },
      },
    }
    expect(await deliverDueEmailNotifications(dependencies)).toBe(0)
    expect(f.digests).toEqual([])
    expect(f.finishes).toEqual([])
    expect(released).toHaveLength(3)
  })
  test('sends instant rows on their own even with a digest sender', async () => {
    const f = fixture({ succeeded: true, retryable: false }, emailOn)
    let digests = 0
    const result = await deliverDueEmailNotifications({ ...f.dependencies, digest: {
      listCompanions: async () => { throw new Error('unexpected') }, send: async () => { digests += 1; return { succeeded: true, retryable: false } },
    } })
    expect(result).toBe(1)
    expect(digests).toBe(0)
  })
})
