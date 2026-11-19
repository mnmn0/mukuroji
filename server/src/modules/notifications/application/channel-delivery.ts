import type { NotificationItem, NotificationPreferences } from '../notifications'
import { createNotificationDeliveryPlan } from '../notifications'
import { CHANNEL_DELIVERY_SHARDS, channelFailedDeliveryShard, type ExternalDeliveryChannel } from '../domain/channel-delivery'

/** One durable external-channel delivery, bound to its original recipient. */
export type ChannelDelivery = {
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
  /** Original planned delivery time, unaffected by lease or transport retries. */
  scheduledAt?: string
  /** Retention deadline in Unix seconds. */
  expiresAt: number
  /** Original scheduled due date, when this is a due/overdue notification. */
  dueDate?: string
  /** Work Item `updatedAt` a stale reminder was computed from, when this is one. */
  workItemUpdatedAt?: string
  /** Whole days until the due date when the schedule emitted the stage (negative once overdue). */
  daysUntilDue?: number
  /** Work Item reopen time an escalation was scanned under, when the item had reopened. */
  workItemReopenedAt?: string
  /** Original approval target, retained independently from its parent Work Item. */
  targetId?: string
  /** Original file subject, when the source is file-backed. */
  fileId?: string
  /** Validated notification contents and authorization scope. */
  notification: NotificationItem
}

/** Safe outcome from one transport attempt. */
export type ChannelSendResult = {
  /** Whether the transport accepted the message. */
  succeeded: boolean
  /** Whether the recipient can never receive this channel, so the delivery ends without an alarm. */
  suppressed?: boolean
  /** Whether delivery may be retried. */
  retryable: boolean
  /** Safe operational failure code, without response bodies or secrets. */
  code?: string
  /** Minimum receiver-requested retry delay. */
  retryAfterMs?: number
}

/** Bounded due-page results, including corrupt candidates that require operator attention. */
export type ChannelDeliveryBatch = {
  /** Valid deliveries retained while scanning past corrupt or stale candidates. */
  deliveries: ChannelDelivery[]
  /** Invalid candidates, including a repeated pagination cursor. */
  invalidCount: number
}

/** Safe lookup coordinates for a failed delivery, without member or workspace identity. */
export type ChannelDeliveryFailure = {
  /** Random reference persisted on the failed row. */
  reference: string
  /** Failed partition in the channel's delivery index. */
  shard: string
  /** Sort key used for an exact failed-index query. */
  dueAt: string
  /** Sanitized failure category. */
  code: string
}

/** Observability port for bounded queue health and actionable failure references. */
export type ChannelDeliveryTelemetry = {
  /** Emits safe failed-index lookup coordinates. */
  reportFailure(failure: ChannelDeliveryFailure): void
  /** Publishes due age and corruption count once per invocation. */
  reportQueueHealth(oldestDueAgeSeconds: number, invalidCandidates: number): void
}

/** Durable queue operations; leases fence concurrent schedule invocations. */
export interface ChannelDeliveryStore {
  /** Reads a bounded page of due candidates and rechecks canonical rows. */
  listDue(shard: string, now: Date, limit: number): Promise<ChannelDeliveryBatch>
  /**
   * Claims an unchanged row until the supplied lease expiry. The claim also waits while another
   * channel holds an unexpired lease on the same row, because every delivery update advances the
   * shared row version that each channel's final fence checks.
   */
  claim(delivery: ChannelDelivery, token: string, leaseUntil: Date, now?: Date): Promise<boolean>
  /** Renews an unexpired claim immediately before the external side effect. */
  renew(delivery: ChannelDelivery, token: string, now: Date): Promise<boolean>
  /** Releases an owned, unsent claim without consuming an attempt. */
  release(delivery: ChannelDelivery, token: string, now: Date): Promise<void>
  /** Finalizes or reschedules only the token's claim, preserving Inbox fields. */
  finish(delivery: ChannelDelivery, token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string): Promise<void>
  /** Strongly reads the recipient's current preferences. */
  getPreferences(delivery: ChannelDelivery): Promise<NotificationPreferences>
}

/** Ports used by a scheduled external-channel notification application. */
export type ChannelDeliveryDependencies = {
  /** Safe logs and queue-health metrics. */
  telemetry: ChannelDeliveryTelemetry
  /** Durable queue and current preferences. */
  store: ChannelDeliveryStore
  /** Revalidates current tenant, member, and source visibility. */
  isAuthorized(delivery: ChannelDelivery): Promise<boolean>
  /** Sends to the recipient-bound destination. */
  send(delivery: ChannelDelivery): Promise<ChannelSendResult>
  /** Provides unique lease ownership tokens. */
  createToken(): string
  /** Clock used for due times, quiet hours, and retry delay. */
  now(): Date
}

/** Channel identity and opt-in rule that parameterize the shared delivery loop. */
export type ChannelDeliveryPolicy = {
  /** Queue attribute prefix and shard prefix. */
  channel: ExternalDeliveryChannel
  /** PascalCase label used in safe failure codes and errors. */
  label: string
  /** Whether current preferences still opt in to this channel for the event time. */
  isEligible(preferences: NotificationPreferences, occurredAt: string): boolean
}

/**
 * Drains a bounded, fair window of due notifications across every queue shard.
 * @param policy - Channel identity, failure label, and opt-in rule.
 * @param dependencies - Persistence, authorization, transport, token, and clock ports.
 * @returns Number of messages the transport acknowledged during this invocation.
 */
export async function deliverDueChannelNotifications(policy: ChannelDeliveryPolicy, dependencies: ChannelDeliveryDependencies): Promise<number> {
  let sent = 0
  let failed = false
  let oldestDueAgeSeconds = 0
  let invalidCandidates = 0
  const deadline = dependencies.now().getTime() + 180_000
  const firstShard = Math.floor(dependencies.now().getTime() / 60_000) % CHANNEL_DELIVERY_SHARDS
  for (let offset = 0; offset < CHANNEL_DELIVERY_SHARDS; offset += 1) {
    if (dependencies.now().getTime() >= deadline) break
    const shard = (firstShard + offset) % CHANNEL_DELIVERY_SHARDS
    let deliveries: ChannelDelivery[]
    try {
      const batch = await dependencies.store.listDue(`${policy.channel}#${shard}`, dependencies.now(), 2)
      deliveries = batch.deliveries
      invalidCandidates += batch.invalidCount
      if (batch.invalidCount > 0) failed = true
    } catch {
      failed = true
      continue
    }
    for (const delivery of deliveries) {
      oldestDueAgeSeconds = Math.max(oldestDueAgeSeconds,
        Math.max(0, (dependencies.now().getTime() - Date.parse(delivery.scheduledAt ?? delivery.nextAttemptAt)) / 1_000))
      if (dependencies.now().getTime() >= deadline) break
      const token = dependencies.createToken()
      try {
        if (!await dependencies.store.claim(delivery, token, new Date(dependencies.now().getTime() + 60_000), dependencies.now())) continue
      } catch {
        // A lost claim response may already own a lease; leave it for expiry and continue other recipients.
        failed = true
        continue
      }
      try {
        if (delivery.attempts >= 5) {
          await dependencies.store.finish(delivery, token, 'failed', undefined, `${policy.label}AttemptsExhausted`)
          reportFailure(policy, dependencies, delivery, token, `${policy.label}AttemptsExhausted`)
          failed = true
          continue
        }
        const initialPreferences = await dependencies.store.getPreferences(delivery)
        if (delivery.expiresAt <= dependencies.now().getTime() / 1_000 || !policy.isEligible(initialPreferences, delivery.notification.occurredAt) || !await dependencies.isAuthorized(delivery)) {
          await dependencies.store.finish(delivery, token, 'suppressed')
          continue
        }
        // Recheck preferences after potentially slow authorization, before the final lease fence and send.
        const preferences = await dependencies.store.getPreferences(delivery)
        if (delivery.expiresAt <= dependencies.now().getTime() / 1_000 || !policy.isEligible(preferences, delivery.notification.occurredAt)) {
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
        if (!await dependencies.store.renew(delivery, token, dependencies.now())) {
          await dependencies.store.release(delivery, token, dependencies.now())
          continue
        }
        const result = await dependencies.send(delivery)
        if (result.succeeded) {
          await dependencies.store.finish(delivery, token, 'sent')
          sent += 1
        } else if (result.suppressed) {
          await dependencies.store.finish(delivery, token, 'suppressed', undefined, result.code)
        } else if (result.retryable && delivery.attempts < 4) {
          const delay = Math.max(30_000 * 2 ** delivery.attempts, result.retryAfterMs ?? 0)
          await dependencies.store.finish(delivery, token, 'pending', new Date(dependencies.now().getTime() + delay), result.code)
        } else {
          await dependencies.store.finish(delivery, token, 'failed', undefined, result.code)
          reportFailure(policy, dependencies, delivery, token, result.code ?? `${policy.label}DeliveryRejected`)
          failed = true
        }
      } catch {
        // Failed authorization/storage reads never permit sending. Preserve a bounded retry path.
        try {
          await dependencies.store.finish(delivery, token, delivery.attempts < 4 ? 'pending' : 'failed',
            delivery.attempts < 4 ? new Date(dependencies.now().getTime() + 60_000) : undefined,
            `${policy.label}DeliveryUnavailable`)
          if (delivery.attempts >= 4) reportFailure(policy, dependencies, delivery, token, `${policy.label}DeliveryUnavailable`)
        } catch { /* A lost lease cannot mutate a newer claim; its canonical row remains authoritative. */ }
        failed = true
      }
    }
  }
  dependencies.telemetry.reportQueueHealth(oldestDueAgeSeconds, invalidCandidates)
  if (failed) throw new Error(`${policy.label} notification delivery requires attention.`)
  return sent
}

/** Emits the exact failed-index lookup coordinates after the failed state is persisted. */
function reportFailure(policy: ChannelDeliveryPolicy, dependencies: ChannelDeliveryDependencies, delivery: ChannelDelivery, token: string, code: string): void {
  dependencies.telemetry.reportFailure({
    reference: token, shard: channelFailedDeliveryShard(policy.channel, delivery.recipientKey), dueAt: delivery.nextAttemptAt, code,
  })
}
