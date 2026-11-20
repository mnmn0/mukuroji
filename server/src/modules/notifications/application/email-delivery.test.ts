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
  test('suppresses events from before the current Email opt-in and after Email is turned off', async () => {
    for (const preferences of [
      { ...emailOn, emailEnabledAt: '2026-09-26T11:30:00.000Z' },
      { ...emailOn, channels: { inApp: true, email: false, push: false } },
    ]) {
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
