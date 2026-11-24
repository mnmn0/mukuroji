import {
  isNotificationChannelPostEventType,
  type NotificationMessage,
} from '@mukuroji/contracts'
import { channelDestinationCandidates, type ChannelDestinationRecord } from '../domain/channel-destination'
import type { ChannelSendResult } from './channel-delivery'
import type { ChannelDestinationStore, ChannelPost, ChannelPostStore } from './ports/channel-posts'

/** Fields of a projected audit event that a channel post is built from. */
export type ChannelPostSourceEvent = {
  /** Audit event ID. */
  eventId: string
  /** Audit event type. */
  eventType: string
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Current Team of the target. */
  teamId?: string
  /** Current Project of the target. */
  projectId?: string
  /** Target title. */
  notificationTitle?: string
  /** Canonical Work Item key read by the projection. */
  workItemKey?: string
  /** Stored English summary. */
  summary?: string
  /** Code and values of the summary. */
  notificationMessage?: NotificationMessage
  /** Relative in-app path of the target. */
  deepLink?: string
  /** When the event happened. */
  occurredAt: string
  /** Work Item of a Work Item event. */
  issueId?: string
  /** Due date a due or overdue event was scheduled for. */
  dueDate?: string
  /** Planning entity of a Milestone event. */
  entityId?: string
  /** Planning update target record of a health update event. */
  planningTargetRecordKey?: string
}

/** Ports the projection uses to queue channel posts. */
export type ChannelPostEnqueueDependencies = {
  /** Destination settings reader. */
  destinations: Pick<ChannelDestinationStore, 'get'>
  /** Post queue. */
  posts: Pick<ChannelPostStore, 'enqueue'>
  /** Current time. */
  now(): Date
}

/**
 * Queues a post for the Project or Team channel of an event, when the event is one that channels
 * receive and its Project or Team has a destination. The Project's destination wins over the
 * Team's. Queuing is idempotent per event, so a retried projection never posts twice.
 *
 * @param event - Projected audit event, with the current Team and Project of its target.
 * @param dependencies - Destination reader, post queue, and clock.
 * @returns True when a post was queued (or had been queued before).
 */
export async function enqueueChannelPost(
  event: ChannelPostSourceEvent,
  dependencies: ChannelPostEnqueueDependencies,
): Promise<boolean> {
  if (!isNotificationChannelPostEventType(event.eventType) || !event.teamId) return false
  for (const target of channelDestinationCandidates(event.teamId, event.projectId)) {
    if (!await dependencies.destinations.get(event.workspaceId, target)) continue
    await dependencies.posts.enqueue({
      workspaceId: event.workspaceId,
      eventId: event.eventId,
      eventType: event.eventType,
      target,
      ...(event.notificationTitle ? { title: event.notificationTitle } : {}),
      ...(event.workItemKey ? { workItemKey: event.workItemKey } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.notificationMessage ? { message: event.notificationMessage } : {}),
      ...(event.deepLink ? { deepLink: event.deepLink } : {}),
      occurredAt: event.occurredAt,
      source: {
        teamId: event.teamId,
        ...(event.projectId ? { projectId: event.projectId } : {}),
        ...(event.issueId ? { issueId: event.issueId } : {}),
        ...(event.dueDate ? { dueDate: event.dueDate } : {}),
        ...(event.entityId ? { entityId: event.entityId } : {}),
        ...(event.planningTargetRecordKey ? { planningTargetRecordKey: event.planningTargetRecordKey } : {}),
      },
    }, dependencies.now())
    return true
  }
  return false
}

/** Sends one post to its destination's chat channel. */
export type ChannelPostSender = (post: ChannelPost, destination: ChannelDestinationRecord) => Promise<ChannelSendResult>

/** Safe operator-facing record of a post that will not be retried. */
export type ChannelPostFailure = {
  /** Queue partition of the failed row. */
  shard: string
  /** Original due time of the failed row. */
  dueAt: string
  /** Random reference also stored on the row. */
  reference: string
  /** Safe outcome code. */
  code: string
}

/** Ports of the scheduled channel post worker. */
export type ChannelPostDeliveryDependencies = {
  /** Destination settings reader. */
  destinations: Pick<ChannelDestinationStore, 'get'>
  /** Post queue. */
  posts: Pick<ChannelPostStore, 'listDue' | 'claim' | 'renew' | 'finish'>
  /**
   * Rechecks, right before sending, that the Workspace is active and the post's source still sits
   * in the Team and Project it was queued for.
   */
  isAuthorized(post: ChannelPost): Promise<boolean>
  /** Chat transport. */
  send: ChannelPostSender
  /** Queue partitions to drain. */
  shards: readonly string[]
  /** Records a post that will not be retried, without its contents or destination. */
  reportFailure(failure: ChannelPostFailure): void
  /** Lease token factory. */
  createToken(): string
  /** Current time. */
  now(): Date
}

/** Posts read per partition per run; Slack accepts about one message per second per webhook. */
const postsPerShard = 8

/** Most attempts before a post is marked failed. */
const maximumAttempts = 5

/**
 * Sends due channel posts. A post whose destination was removed, whose Workspace is no longer
 * active, or whose source left the queued Team or Project is dropped. The lease is renewed right
 * before sending, and transport failures are retried with backoff up to five attempts.
 *
 * @param dependencies - Queue, destination reader, transport, and clock.
 * @returns Number of posts the chat service accepted.
 */
export async function deliverDueChannelPosts(dependencies: ChannelPostDeliveryDependencies): Promise<number> {
  let delivered = 0
  let invalidCount = 0
  let failedCount = 0
  for (const shard of dependencies.shards) {
    const page = await dependencies.posts.listDue(shard, dependencies.now(), postsPerShard)
    invalidCount += page.invalidCount
    for (const post of page.posts) {
      const token = dependencies.createToken()
      const claimedAt = dependencies.now()
      if (!await dependencies.posts.claim(post, token, new Date(claimedAt.getTime() + 60_000))) continue
      const claimed: ChannelPost = { ...post, version: post.version + 1, attempts: post.attempts + 1 }
      let destination: ChannelDestinationRecord | undefined
      let authorized: boolean
      try {
        destination = await dependencies.destinations.get(post.workspaceId, post.target)
        authorized = destination ? await dependencies.isAuthorized(claimed) : false
      } catch {
        // Failed reads never permit sending.
        if (!await retryOrFail(dependencies, claimed, token, { succeeded: false, retryable: true, code: 'NotificationDestinationUnavailable' })) failedCount += 1
        continue
      }
      if (!destination) {
        await dependencies.posts.finish(claimed, token, 'suppressed', undefined, 'DestinationRemoved')
        continue
      }
      if (!authorized) {
        await dependencies.posts.finish(claimed, token, 'suppressed', undefined, 'SourceOutOfScope')
        continue
      }
      // Reads above can stall past the lease; send only while this attempt still holds it.
      if (!await dependencies.posts.renew(claimed, token, dependencies.now())) continue
      const leased: ChannelPost = { ...claimed, version: claimed.version + 1 }
      const result = await dependencies.send(leased, destination)
      if (result.succeeded) {
        await dependencies.posts.finish(leased, token, 'sent')
        delivered += 1
      } else if (!await retryOrFail(dependencies, leased, token, result)) {
        failedCount += 1
      }
    }
  }
  // Failing the run raises the scheduled-jobs alarm; the rows stay in the failed partition.
  if (invalidCount > 0 || failedCount > 0) {
    throw new Error(`Channel posts: ${failedCount} failed, ${invalidCount} unreadable queue candidates.`)
  }
  return delivered
}

/**
 * Schedules a retry of a failed attempt, or marks the post failed after the last attempt.
 * @param dependencies - Queue, reporter, and clock.
 * @param post - Claimed post, with this attempt counted.
 * @param token - Lease token of the claim.
 * @param result - Outcome of the attempt.
 * @returns True when a retry was scheduled, false when the post was marked failed.
 */
async function retryOrFail(
  dependencies: ChannelPostDeliveryDependencies,
  post: ChannelPost,
  token: string,
  result: ChannelSendResult,
): Promise<boolean> {
  const code = result.code ?? 'ChannelPostFailed'
  if (result.retryable && post.attempts < maximumAttempts) {
    const delay = Math.max(30_000 * 2 ** (post.attempts - 1), result.retryAfterMs ?? 0)
    await dependencies.posts.finish(post, token, 'pending', new Date(dependencies.now().getTime() + delay), code)
    return true
  }
  await dependencies.posts.finish(post, token, 'failed', undefined, code)
  dependencies.reportFailure({
    shard: post.shard.replace('slack-channel#', 'slack-channel-failed#'),
    dueAt: post.nextAttemptAt,
    reference: token,
    code,
  })
  return false
}
