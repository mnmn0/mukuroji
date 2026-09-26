import { describe, expect, test } from 'bun:test'
import { deliverDueSlackNotifications, type SlackDelivery, type SlackDeliveryDependencies, type SlackDeliveryFailure, type SlackSendResult } from './slack-delivery'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../notifications'
import { DocumentError } from '../../documents'
import { isDocumentDeliveryVisible } from './document-delivery'

/** Creates an isolated queue fixture with a controllable Slack outcome. */
function fixture(result: SlackSendResult = { succeeded: true, retryable: false }) {
  const now = new Date('2026-09-26T12:00:00.000Z')
  const delivery: SlackDelivery = {
    workspaceId: 'workspace-1', memberKey: 'member@example.test', recipientKey: 'workspace-1#member@example.test',
    notificationKey: '2026-09-26T11:00:00.000Z#event-1', attempts: 0, version: 1,
    nextAttemptAt: now.toISOString(), expiresAt: now.getTime() / 1_000 + 3_600,
    notification: { id: 'notification-1', eventId: 'event-1', eventType: 'comment.created',
      reasons: ['mention'], title: 'Review', occurredAt: '2026-09-26T11:00:00.000Z', state: 'unread' },
  }
  const finishes: Array<{ status: string; next?: Date; code?: string }> = []
  let sends = 0
  let releases = 0
  const failures: SlackDeliveryFailure[] = []
  const health: Array<[number, number]> = []
  let pending = true
  const dependencies: SlackDeliveryDependencies = {
    telemetry: {
      reportFailure: (failure) => { failures.push(failure) },
      reportQueueHealth: (age, invalid) => { health.push([age, invalid]) },
    },
    now: () => now, createToken: () => 'lease-1',
    isAuthorized: async () => true,
    send: async () => { sends += 1; return result },
    store: {
      listDue: async (shard) => ({ deliveries: shard === 'slack#0' && pending ? [delivery] : [], invalidCount: 0 }),
      claim: async () => true,
      renew: async () => true,
      release: async () => { releases += 1 },
      getPreferences: async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES,
        channels: { inApp: false, email: false, push: false, slack: true } }),
      finish: async (_delivery, _token, status, next, code) => {
        finishes.push({ status, next, code }); pending = false
      },
    },
  }
  return { delivery, dependencies, finishes, sends: () => sends, releases: () => releases, failures, health, now }
}

describe('Slack notification delivery application', () => {
  test('does not post private document content after the Documents capability denies the recipient', async () => {
    const f = fixture()
    f.delivery.notification.eventType = 'document.comment.created'
    f.delivery.notification.entityId = 'private-document'
    f.delivery.notification.title = 'Private document title'
    f.dependencies.isAuthorized = (delivery) => isDocumentDeliveryVisible(
      delivery.workspaceId, delivery.notification.entityId,
      { memberKey: delivery.memberKey, workspaceRole: 'member' },
      async () => { throw new DocumentError(403, 'DocumentViewDenied', 'Denied') },
    )
    expect(await deliverDueSlackNotifications(f.dependencies)).toBe(0)
    expect(f.sends()).toBe(0)
    expect(f.finishes[0]?.status).toBe('suppressed')
  })
  test('sends the existing notification with Inbox disabled and does not replay a completed job', async () => {
    const f = fixture()
    expect(await deliverDueSlackNotifications(f.dependencies)).toBe(1)
    expect(await deliverDueSlackNotifications(f.dependencies)).toBe(0)
    expect(f.sends()).toBe(1)
    expect(f.finishes[0]?.status).toBe('sent')
  })
  test('suppresses disabled, expired, or no-longer-authorized notifications before sending', async () => {
    for (const reason of ['disabled', 'expired', 'unauthorized']) {
      const f = fixture()
      if (reason === 'disabled') f.dependencies.store.getPreferences = async () => DEFAULT_NOTIFICATION_PREFERENCES
      if (reason === 'expired') f.delivery.expiresAt = 1
      if (reason === 'unauthorized') f.dependencies.isAuthorized = async () => false
      expect(await deliverDueSlackNotifications(f.dependencies)).toBe(0)
      expect(f.sends()).toBe(0)
      expect(f.finishes[0]?.status).toBe('suppressed')
    }
  })
  test('defers for current quiet hours and snooze instead of sending', async () => {
    for (const reason of ['quiet', 'snoozed']) {
      const f = fixture()
      if (reason === 'quiet') {
        f.dependencies.store.getPreferences = async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES,
          channels: { inApp: true, email: false, push: false, slack: true },
          quietHours: { enabled: true, start: '11:00', end: '13:00', timeZone: 'UTC' } })
      } else f.delivery.notification.snoozedUntil = '2026-09-26T13:00:00.000Z'
      await deliverDueSlackNotifications(f.dependencies)
      expect(f.sends()).toBe(0)
      expect(f.finishes).toEqual([{ status: 'pending', next: new Date('2026-09-26T13:00:00.000Z'), code: undefined }])
    }
  })
  test('losing a claim or its lease prevents the HTTP side effect', async () => {
    for (const method of ['claim', 'renew'] as const) {
      const f = fixture()
      f.dependencies.store[method] = async () => false
      await deliverDueSlackNotifications(f.dependencies)
      expect(f.sends()).toBe(0)
    }
  })
  test('honors preferences changed while authorization is in flight', async () => {
    for (const change of ['disable', 'quiet-hours']) {
      const f = fixture()
      let changed = false
      f.dependencies.store.getPreferences = async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES,
        channels: { inApp: true, email: false, push: false, slack: change !== 'disable' || !changed },
        quietHours: { enabled: change === 'quiet-hours' && changed, start: '11:00', end: '13:00', timeZone: 'UTC' },
      })
      f.dependencies.isAuthorized = async () => { changed = true; return true }
      expect(await deliverDueSlackNotifications(f.dependencies)).toBe(0)
      expect(f.sends()).toBe(0)
      expect(f.finishes[0]?.status).toBe(change === 'disable' ? 'suppressed' : 'pending')
      if (change === 'quiet-hours') expect(f.finishes[0]?.next?.toISOString()).toBe('2026-09-26T13:00:00.000Z')
    }
  })
  test('retains Slack Retry-After and terminates exhausted or permanent failures', async () => {
    const f = fixture({ succeeded: false, retryable: true, code: 'SlackRateLimited', retryAfterMs: 120_000 })
    await deliverDueSlackNotifications(f.dependencies)
    expect(f.finishes[0]?.next?.toISOString()).toBe('2026-09-26T12:02:00.000Z')
    for (const permanent of [false, true]) {
      const exhausted = fixture({ succeeded: false, retryable: !permanent, code: 'SlackDeliveryRejected' })
      exhausted.delivery.attempts = 4
      await expect(deliverDueSlackNotifications(exhausted.dependencies)).rejects.toThrow('requires attention')
      expect(exhausted.finishes[0]?.status).toBe('failed')
      expect(exhausted.failures[0]?.reference).toBe('lease-1')
      expect(exhausted.failures[0]?.shard).toStartWith('slack-failed#')
      expect(JSON.stringify(exhausted.failures)).not.toContain('member@example.test')
    }
  })
  test('authorization failures fail closed and keep bounded retry work', async () => {
    const f = fixture()
    f.dependencies.isAuthorized = async () => { throw new Error('Temporary read failure') }
    await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
    expect(f.sends()).toBe(0)
    expect(f.finishes[0]?.status).toBe('pending')
  })
  test('does not send again after five attempts whose workers lost their acknowledgements', async () => {
    const f = fixture()
    f.delivery.attempts = 5
    await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
    expect(f.sends()).toBe(0)
    expect(f.finishes[0]).toEqual({ status: 'failed', next: undefined, code: 'SlackAttemptsExhausted' })
  })
  test('an unreadable shard does not prevent delivery from another shard', async () => {
    const f = fixture()
    f.dependencies.store.listDue = async (shard) => {
      if (shard === 'slack#1') throw new Error('Unavailable shard')
      return { deliveries: shard === 'slack#2' ? [f.delivery] : [], invalidCount: 0 }
    }
    await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
    expect(f.sends()).toBe(1)
  })
  test('a transient claim failure preserves unrelated deliveries and queue health', async () => {
    const f = fixture()
    const unavailable = { ...f.delivery, notificationKey: 'unavailable', scheduledAt: '2026-09-26T11:30:00.000Z' }
    f.dependencies.store.listDue = async (shard) => ({
      deliveries: shard === 'slack#0' ? [unavailable, f.delivery] : shard === 'slack#1' ? [f.delivery] : [], invalidCount: 0,
    })
    f.dependencies.store.claim = async (delivery) => {
      if (delivery.notificationKey === 'unavailable') throw new Error('Throttled')
      return true
    }
    await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
    expect(f.sends()).toBe(2)
    expect(f.finishes.map((finish) => finish.status)).toEqual(['sent', 'sent'])
    expect(f.health).toEqual([[1_800, 0]])
  })
  test('corrupt preferences are retried and eventually reported rather than suppressed', async () => {
    for (const attempts of [0, 4]) {
      const f = fixture()
      f.delivery.attempts = attempts
      f.dependencies.store.getPreferences = async () => { throw new Error('Invalid stored preferences') }
      await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
      expect(f.sends()).toBe(0)
      expect(f.finishes[0]?.status).toBe(attempts === 4 ? 'failed' : 'pending')
      expect(f.finishes[0]?.code).toBe('SlackDeliveryUnavailable')
      expect(f.failures).toHaveLength(attempts === 4 ? 1 : 0)
    }
  })
  test('releases repeated unsent Inbox conflicts without exhausting delivery attempts', async () => {
    const f = fixture()
    f.dependencies.store.renew = async () => false
    for (let i = 0; i < 6; i += 1) await deliverDueSlackNotifications(f.dependencies)
    expect(f.releases()).toBe(6)
    expect(f.sends()).toBe(0)
    expect(f.failures).toEqual([])
  })
  test('reports overdue age and corruption while still delivering valid candidates', async () => {
    const f = fixture()
    f.delivery.scheduledAt = '2026-09-26T11:30:00.000Z'
    f.dependencies.store.listDue = async (shard) => ({
      deliveries: shard === 'slack#0' ? [f.delivery] : [], invalidCount: shard === 'slack#0' ? 1 : 0,
    })
    await expect(deliverDueSlackNotifications(f.dependencies)).rejects.toThrow('requires attention')
    expect(f.sends()).toBe(1)
    expect(f.health).toEqual([[1_800, 1]])
  })
})
