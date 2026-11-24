import type { NotificationMessageLocale } from '@mukuroji/contracts'
import type { NotificationFrequency, NotificationItem, NotificationPreferences } from '../notifications'
import { createNotificationDeliveryPlan, isNotificationRoutedToChannel } from '../notifications'
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
  /** Frequency the recipient chose when the notification was queued; digests group non-instant rows. */
  deliveryFrequency?: NotificationFrequency
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
  /** Author of the unsubmitted weekly report, when this is a weekly report reminder or escalation. */
  weeklyReportAuthorMemberKey?: string
  /** First day of the week a weekly report reminder or escalation is about, when this is one. */
  weeklyReportWeekStart?: string
  /** Unsubmitted time entries a timesheet reminder was scanned for, when this is one. */
  timeEntryIds?: string[]
  /** Instant at or before which a timesheet reminder's entries had to end, when this is one. */
  timesheetDueBefore?: string
  /** Original approval target, retained independently from its parent Work Item. */
  targetId?: string
  /** Original file subject, when the source is file-backed. */
  fileId?: string
  /** Validated notification contents and authorization scope. */
  notification: NotificationItem
}

/**
 * Reads the language a recipient chose for system-written text.
 * Transient failures reject, so the delivery is retried instead of sent in the wrong language.
 * It must reject once `signal` aborts, so a sender never goes on after its delivery lease ends.
 */
export type NotificationLocaleReader = (
  recipient: Pick<ChannelDelivery, 'workspaceId' | 'memberKey'>,
  signal?: AbortSignal,
) => Promise<NotificationMessageLocale>

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
  /**
   * Groups a recipient's due non-instant notifications into one message. Without it, every
   * notification is sent on its own.
   */
  digest?: ChannelDigestDependencies
}

/** Ports that send several due notifications of one recipient as one digest message. */
export type ChannelDigestDependencies = {
  /**
   * Lists the recipient's other due, non-instant deliveries in the same queue shard, excluding
   * `delivery` itself, at most `limit`.
   */
  listCompanions(delivery: ChannelDelivery, now: Date, limit: number): Promise<ChannelDelivery[]>
  /** Sends one digest for every delivery, which all share one recipient. */
  send(deliveries: ChannelDelivery[]): Promise<ChannelSendResult>
}

/** Most notifications one digest message carries; any more are sent in the next run. */
export const MAX_DIGEST_NOTIFICATIONS = 50

/**
 * Longest the digest may spend renewing its rows. A renewal grants 60 seconds and the transport
 * allows itself 30, so finishing the renewals within 25 seconds keeps every included lease valid,
 * with a margin, until the send has finished.
 */
const DIGEST_RENEWAL_BUDGET_MS = 25_000

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
  const run: DeliveryRun = { policy, dependencies, sent: 0, failed: false, deadline: dependencies.now().getTime() + 180_000 }
  let oldestDueAgeSeconds = 0
  let invalidCandidates = 0
  const firstShard = Math.floor(dependencies.now().getTime() / 60_000) % CHANNEL_DELIVERY_SHARDS
  for (let offset = 0; offset < CHANNEL_DELIVERY_SHARDS; offset += 1) {
    if (dependencies.now().getTime() >= run.deadline) break
    const shard = (firstShard + offset) % CHANNEL_DELIVERY_SHARDS
    let deliveries: ChannelDelivery[]
    try {
      const batch = await dependencies.store.listDue(`${policy.channel}#${shard}`, dependencies.now(), 2)
      deliveries = batch.deliveries
      invalidCandidates += batch.invalidCount
      if (batch.invalidCount > 0) run.failed = true
    } catch {
      run.failed = true
      continue
    }
    const handled = new Set<string>()
    for (const delivery of deliveries) {
      oldestDueAgeSeconds = Math.max(oldestDueAgeSeconds,
        Math.max(0, (dependencies.now().getTime() - Date.parse(delivery.scheduledAt ?? delivery.nextAttemptAt)) / 1_000))
      if (dependencies.now().getTime() >= run.deadline) break
      if (handled.has(deliveryIdentity(delivery))) continue
      if (dependencies.digest && isDigestDelivery(delivery)) {
        for (const identity of await deliverDigest(run, dependencies.digest, delivery)) handled.add(identity)
      } else {
        await deliverOne(run, delivery)
      }
    }
  }
  dependencies.telemetry.reportQueueHealth(oldestDueAgeSeconds, invalidCandidates)
  if (run.failed) throw new Error(`${policy.label} notification delivery requires attention.`)
  return run.sent
}

/** Mutable state of one scheduled invocation. */
type DeliveryRun = {
  /** Channel identity and opt-in rule. */
  policy: ChannelDeliveryPolicy
  /** Persistence, authorization, transport, token, and clock ports. */
  dependencies: ChannelDeliveryDependencies
  /** Notifications the transport acknowledged so far. */
  sent: number
  /** Whether any failure needs operator attention. */
  failed: boolean
  /** Epoch milliseconds after which no new claim starts. */
  deadline: number
}

/** One claimed delivery and its lease token. */
type ClaimedDelivery = {
  /** Claimed delivery. */
  delivery: ChannelDelivery
  /** Lease token owned by this invocation. */
  token: string
}

/**
 * Builds the identity of one queued notification row.
 * @param delivery - Queued delivery.
 * @returns Recipient and notification key.
 */
function deliveryIdentity(delivery: Pick<ChannelDelivery, 'recipientKey' | 'notificationKey'>): string {
  return `${delivery.recipientKey}\n${delivery.notificationKey}`
}

/**
 * Reports whether a delivery belongs in a digest: the recipient chose hourly, daily, or weekly.
 * @param delivery - Queued delivery.
 * @returns `true` for a non-instant frequency.
 */
function isDigestDelivery(delivery: ChannelDelivery): boolean {
  return delivery.deliveryFrequency !== undefined && delivery.deliveryFrequency !== 'instant'
}

/**
 * Claims one delivery, failing closed on a lost response.
 * @param run - Invocation state.
 * @param delivery - Delivery to claim.
 * @param leaseMs - Lease length from now.
 * @returns The claim, or undefined when another worker owns it or the claim failed.
 */
async function claimDelivery(run: DeliveryRun, delivery: ChannelDelivery, leaseMs: number): Promise<ClaimedDelivery | undefined> {
  const token = run.dependencies.createToken()
  try {
    const now = run.dependencies.now()
    return await run.dependencies.store.claim(delivery, token, new Date(now.getTime() + leaseMs), now) ? { delivery, token } : undefined
  } catch {
    // A lost claim response may already own a lease; leave it for expiry and continue other recipients.
    run.failed = true
    return undefined
  }
}

/**
 * Applies every check that must pass before a claimed delivery may be sent: attempt limit,
 * retention, current opt-in and routing, current authorization, quiet hours, and snooze. A
 * delivery that fails a check is finished here.
 * @param run - Invocation state.
 * @param claimed - Claimed delivery.
 * @returns Whether the delivery is still ready to send; the lease still needs a final renewal.
 */
async function checkClaimed(run: DeliveryRun, claimed: ClaimedDelivery): Promise<boolean> {
  const { policy, dependencies } = run
  const { delivery, token } = claimed
  try {
    if (delivery.attempts >= 5) {
      await dependencies.store.finish(delivery, token, 'failed', undefined, `${policy.label}AttemptsExhausted`)
      reportFailure(policy, dependencies, delivery, token, `${policy.label}AttemptsExhausted`)
      run.failed = true
      return false
    }
    const initialPreferences = await dependencies.store.getPreferences(delivery)
    if (delivery.expiresAt <= dependencies.now().getTime() / 1_000 || !isChannelEligible(policy, initialPreferences, delivery) || !await dependencies.isAuthorized(delivery)) {
      await dependencies.store.finish(delivery, token, 'suppressed')
      return false
    }
    // Recheck preferences after potentially slow authorization, before the final lease fence and send.
    const preferences = await dependencies.store.getPreferences(delivery)
    if (delivery.expiresAt <= dependencies.now().getTime() / 1_000 || !isChannelEligible(policy, preferences, delivery)) {
      await dependencies.store.finish(delivery, token, 'suppressed')
      return false
    }
    const now = dependencies.now()
    const quietUntil = createNotificationDeliveryPlan({ ...preferences, frequency: 'instant' }, now.toISOString()).deliveryAfter
    const snoozedUntil = delivery.notification.snoozedUntil ?? now.toISOString()
    const eligibleAt = new Date(quietUntil > snoozedUntil ? quietUntil : snoozedUntil)
    if (eligibleAt > now) {
      await dependencies.store.finish(delivery, token, 'pending', eligibleAt)
      return false
    }
    return true
  } catch {
    await finishUnavailable(run, claimed)
    return false
  }
}

/**
 * Renews a checked claim immediately before the external side effect, releasing it when lost.
 * @param run - Invocation state.
 * @param claimed - Checked claim.
 * @returns Whether this invocation still owns the delivery.
 */
async function renewClaimed(run: DeliveryRun, claimed: ClaimedDelivery): Promise<boolean> {
  try {
    if (await run.dependencies.store.renew(claimed.delivery, claimed.token, run.dependencies.now())) return true
    await run.dependencies.store.release(claimed.delivery, claimed.token, run.dependencies.now())
    return false
  } catch {
    await finishUnavailable(run, claimed)
    return false
  }
}

/**
 * Gives a claimed delivery back without consuming an attempt. A failed release is left to the
 * lease expiry, which frees the row just the same.
 * @param run - Invocation state.
 * @param claimed - Delivery and the lease token this invocation holds.
 */
async function releaseClaimed(run: DeliveryRun, claimed: ClaimedDelivery): Promise<void> {
  try {
    await run.dependencies.store.release(claimed.delivery, claimed.token, run.dependencies.now())
  } catch {
    // The lease expires on its own.
  }
}

/**
 * Records one transport outcome on a claimed delivery.
 * @param run - Invocation state.
 * @param claimed - Delivery that was handed to the transport.
 * @param result - Transport outcome.
 */
async function completeClaimed(run: DeliveryRun, claimed: ClaimedDelivery, result: ChannelSendResult): Promise<void> {
  const { policy, dependencies } = run
  const { delivery, token } = claimed
  try {
    if (result.succeeded) {
      await dependencies.store.finish(delivery, token, 'sent')
      run.sent += 1
    } else if (result.suppressed) {
      await dependencies.store.finish(delivery, token, 'suppressed', undefined, result.code)
    } else if (result.retryable && delivery.attempts < 4) {
      const delay = Math.max(30_000 * 2 ** delivery.attempts, result.retryAfterMs ?? 0)
      await dependencies.store.finish(delivery, token, 'pending', new Date(dependencies.now().getTime() + delay), result.code)
    } else {
      await dependencies.store.finish(delivery, token, 'failed', undefined, result.code)
      reportFailure(policy, dependencies, delivery, token, result.code ?? `${policy.label}DeliveryRejected`)
      run.failed = true
    }
  } catch {
    await finishUnavailable(run, claimed)
  }
}

/**
 * Keeps a bounded retry path after a failed storage or authorization read, which never permits sending.
 * @param run - Invocation state.
 * @param claimed - Claimed delivery.
 */
async function finishUnavailable(run: DeliveryRun, claimed: ClaimedDelivery): Promise<void> {
  const { policy, dependencies } = run
  const { delivery, token } = claimed
  try {
    await dependencies.store.finish(delivery, token, delivery.attempts < 4 ? 'pending' : 'failed',
      delivery.attempts < 4 ? new Date(dependencies.now().getTime() + 60_000) : undefined,
      `${policy.label}DeliveryUnavailable`)
    if (delivery.attempts >= 4) reportFailure(policy, dependencies, delivery, token, `${policy.label}DeliveryUnavailable`)
  } catch { /* A lost lease cannot mutate a newer claim; its canonical row remains authoritative. */ }
  run.failed = true
}

/**
 * Sends one notification on its own.
 * @param run - Invocation state.
 * @param delivery - Due delivery.
 */
async function deliverOne(run: DeliveryRun, delivery: ChannelDelivery): Promise<void> {
  const claimed = await claimDelivery(run, delivery, 60_000)
  if (!claimed || !await checkClaimed(run, claimed) || !await renewClaimed(run, claimed)) return
  let result: ChannelSendResult
  try {
    result = await run.dependencies.send(delivery)
  } catch {
    await finishUnavailable(run, claimed)
    return
  }
  await completeClaimed(run, claimed, result)
}

/**
 * Sends a recipient's due non-instant notifications as one digest. Every row is claimed and
 * checked on its own exactly as a single send is; only the rows that pass and still hold their
 * lease right before sending are included, and all of them share the one transport outcome.
 * @param run - Invocation state.
 * @param digest - Digest listing and transport ports.
 * @param delivery - Due delivery that started the digest.
 * @returns Identities of every row this digest looked at, so the shard loop skips them.
 */
async function deliverDigest(run: DeliveryRun, digest: ChannelDigestDependencies, delivery: ChannelDelivery): Promise<string[]> {
  let companions: ChannelDelivery[] = []
  try {
    companions = (await digest.listCompanions(delivery, run.dependencies.now(), MAX_DIGEST_NOTIFICATIONS - 1))
      .filter((companion) => companion.recipientKey === delivery.recipientKey && isDigestDelivery(companion) &&
        deliveryIdentity(companion) !== deliveryIdentity(delivery))
  } catch {
    // Without the companions the row is still sent, as a digest of one.
    run.failed = true
  }
  const candidates = [delivery, ...companions].slice(0, MAX_DIGEST_NOTIFICATIONS)
  const checked: ClaimedDelivery[] = []
  for (const candidate of candidates) {
    if (run.dependencies.now().getTime() >= run.deadline) break
    // A longer lease covers checking every row; each is renewed again right before the send.
    const claimed = await claimDelivery(run, candidate, 120_000)
    if (claimed && await checkClaimed(run, claimed)) checked.push(claimed)
  }
  const ready: ClaimedDelivery[] = []
  // The first renewal's lease expires first, so the renewals and the send must both fit inside it.
  const renewalStartedAt = run.dependencies.now().getTime()
  for (const claimed of checked) {
    if (await renewClaimed(run, claimed)) ready.push(claimed)
  }
  if (ready.length > 0 && run.dependencies.now().getTime() - renewalStartedAt > DIGEST_RENEWAL_BUDGET_MS) {
    // Too slow to keep every lease through the send: hand the rows back untouched for the next run.
    for (const claimed of ready) await releaseClaimed(run, claimed)
    return candidates.map(deliveryIdentity)
  }
  if (ready.length > 0) {
    let result: ChannelSendResult | undefined
    try {
      result = await digest.send(ready.map((claimed) => claimed.delivery))
    } catch {
      for (const claimed of ready) await finishUnavailable(run, claimed)
    }
    if (result) for (const claimed of ready) await completeClaimed(run, claimed, result)
  }
  return candidates.map(deliveryIdentity)
}

/**
 * Rechecks the channel opt-in period and the member's current category and mute settings, so a
 * category turned off or a Project muted after the notification was queued stops the send.
 * @param policy - Channel identity and opt-in rule.
 * @param preferences - Strongly read current preferences.
 * @param delivery - Queued delivery and its notification.
 * @returns Whether the channel may still send the notification.
 */
function isChannelEligible(policy: ChannelDeliveryPolicy, preferences: NotificationPreferences, delivery: ChannelDelivery): boolean {
  return policy.isEligible(preferences, delivery.notification.occurredAt) &&
    isNotificationRoutedToChannel(preferences, delivery.notification, policy.channel)
}

/** Emits the exact failed-index lookup coordinates after the failed state is persisted. */
function reportFailure(policy: ChannelDeliveryPolicy, dependencies: ChannelDeliveryDependencies, delivery: ChannelDelivery, token: string, code: string): void {
  dependencies.telemetry.reportFailure({
    reference: token, shard: channelFailedDeliveryShard(policy.channel, delivery.recipientKey), dueAt: delivery.nextAttemptAt, code,
  })
}
