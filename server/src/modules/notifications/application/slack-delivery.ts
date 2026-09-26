import type { NotificationItem, NotificationPreferences } from '../notifications'
import { createNotificationDeliveryPlan } from '../notifications'
import { SLACK_DELIVERY_SHARDS } from '../domain/slack-delivery'

/** One durable Slack delivery, bound to its original recipient. */
export type SlackDelivery = {
  /** Canonical workspace identity. */
  workspaceId: string
  /** Normalized recipient member key. */
  memberKey: string
  /** Recipient partition used as the persistence identity. */
  recipientKey: string
  /** Notification timeline identity. */
  notificationKey: string
  /** Number of previously claimed attempts. */
  attempts: number
  /** Optimistic row revision read before claiming. */
  version: number
  /** Next eligible attempt timestamp. */
  nextAttemptAt: string
  /** Retention deadline in Unix seconds. */
  expiresAt: number
  /** Original scheduled due date, when this is a due/overdue notification. */
  dueDate?: string
  /** Validated notification contents and authorization scope. */
  notification: NotificationItem
}

/** Safe outcome from one Slack HTTP attempt. */
export type SlackSendResult = {
  /** Whether Slack acknowledged the message. */
  succeeded: boolean
  /** Whether delivery may be retried. */
  retryable: boolean
  /** Safe operational failure code, without response bodies or secrets. */
  code?: string
  /** Minimum receiver-requested retry delay. */
  retryAfterMs?: number
}

/** Durable queue operations; leases fence concurrent schedule invocations. */
export interface SlackDeliveryStore {
  /** Reads a bounded page of due candidates and rechecks canonical rows. */
  listDue(shard: string, now: Date, limit: number): Promise<SlackDelivery[]>
  /** Claims an unchanged row until the supplied lease expiry. */
  claim(delivery: SlackDelivery, token: string, leaseUntil: Date): Promise<boolean>
  /** Renews an unexpired claim immediately before the external side effect. */
  renew(delivery: SlackDelivery, token: string, now: Date): Promise<boolean>
  /** Finalizes or reschedules only the token's claim, preserving Inbox fields. */
  finish(delivery: SlackDelivery, token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string): Promise<void>
  /** Strongly reads the recipient's current preferences. */
  getPreferences(delivery: SlackDelivery): Promise<NotificationPreferences>
}

/** Ports used by the scheduled Slack notification application. */
export type SlackDeliveryDependencies = {
  /** Durable queue and current preferences. */
  store: SlackDeliveryStore
  /** Revalidates current tenant, member, and source visibility. */
  isAuthorized(delivery: SlackDelivery): Promise<boolean>
  /** Sends using a recipient-bound secret destination. */
  send(delivery: SlackDelivery): Promise<SlackSendResult>
  /** Provides unique lease ownership tokens. */
  createToken(): string
  /** Clock used for due times, quiet hours, and retry delay. */
  now(): Date
}

/**
 * Drains a bounded, fair window of due notifications across every queue shard.
 * @param dependencies - Persistence, authorization, transport, token, and clock ports.
 * @returns Number of Slack messages acknowledged during this invocation.
 */
export async function deliverDueSlackNotifications(dependencies: SlackDeliveryDependencies): Promise<number> {
  let sent = 0
  let failed = false
  const deadline = dependencies.now().getTime() + 180_000
  const firstShard = Math.floor(dependencies.now().getTime() / 60_000) % SLACK_DELIVERY_SHARDS
  for (let offset = 0; offset < SLACK_DELIVERY_SHARDS; offset += 1) {
    if (dependencies.now().getTime() >= deadline) break
    const shard = (firstShard + offset) % SLACK_DELIVERY_SHARDS
    let deliveries: SlackDelivery[]
    try {
      deliveries = await dependencies.store.listDue(`slack#${shard}`, dependencies.now(), 2)
    } catch {
      failed = true
      continue
    }
    for (const delivery of deliveries) {
      if (dependencies.now().getTime() >= deadline) break
      const token = dependencies.createToken()
      if (!await dependencies.store.claim(delivery, token, new Date(dependencies.now().getTime() + 60_000))) continue
      try {
        if (delivery.attempts >= 5) {
          await dependencies.store.finish(delivery, token, 'failed', undefined, 'SlackAttemptsExhausted')
          failed = true
          continue
        }
        const preferences = await dependencies.store.getPreferences(delivery)
        if (delivery.expiresAt <= dependencies.now().getTime() / 1_000 || !preferences.channels.slack || !await dependencies.isAuthorized(delivery)) {
          await dependencies.store.finish(delivery, token, 'suppressed')
          continue
        }
        const now = dependencies.now()
        const quietUntil = createNotificationDeliveryPlan({ ...preferences, frequency: 'instant' }, now.toISOString()).deliveryAfter
        const snoozedUntil = delivery.notification.snoozedUntil ?? now.toISOString()
        const eligibleAt = new Date(quietUntil > snoozedUntil ? quietUntil : snoozedUntil)
        if (eligibleAt > now) {
          await dependencies.store.finish(delivery, token, 'pending', eligibleAt)
          continue
        }
        if (!await dependencies.store.renew(delivery, token, dependencies.now())) continue
        const result = await dependencies.send(delivery)
        if (result.succeeded) {
          await dependencies.store.finish(delivery, token, 'sent')
          sent += 1
        } else if (result.retryable && delivery.attempts < 4) {
          const delay = Math.max(30_000 * 2 ** delivery.attempts, result.retryAfterMs ?? 0)
          await dependencies.store.finish(delivery, token, 'pending', new Date(dependencies.now().getTime() + delay), result.code)
        } else {
          await dependencies.store.finish(delivery, token, 'failed', undefined, result.code)
          failed = true
        }
      } catch {
        // Failed authorization/storage reads never permit sending. Preserve a bounded retry path.
        try {
          await dependencies.store.finish(delivery, token, delivery.attempts < 4 ? 'pending' : 'failed',
            delivery.attempts < 4 ? new Date(dependencies.now().getTime() + 60_000) : undefined,
            'SlackDeliveryUnavailable')
        } catch { /* A lost lease cannot mutate a newer claim; its canonical row remains authoritative. */ }
        failed = true
      }
    }
  }
  if (failed) throw new Error('Slack notification delivery requires attention.')
  return sent
}
