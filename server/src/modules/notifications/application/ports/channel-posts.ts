import type { NotificationChannelPostEventType, NotificationMessage, NotificationMessageLocale } from '@mukuroji/contracts'
import type { AuditTransactWriteItem } from '../../../audit'
import type { ChannelDestinationRecord, ChannelDestinationTarget } from '../../domain/channel-destination'

/** Save of a Team or Project channel destination's settings. */
export type SaveChannelDestinationInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Team or Project that owns the destination. */
  target: ChannelDestinationTarget
  /** Optional channel name. */
  label?: string
  /** Language of the posts. */
  locale: NotificationMessageLocale
  /** Revision the caller read; 0 when creating. */
  expectedRevision: number
  /** Webhook secret version the settings point at after the save. */
  secretVersion: string
  /** Member who saves. */
  updatedBy: string
  /** Save time. */
  now: Date
  /** Read-only checks on the caller's authorization rows, committed with the save. */
  authorizationConditionChecks?: readonly AuditTransactWriteItem[]
  /** Audit event written in the same transaction. */
  auditPut?: AuditTransactWriteItem
}

/** Delete of a Team or Project channel destination's settings. */
export type DeleteChannelDestinationInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Team or Project that owns the destination. */
  target: ChannelDestinationTarget
  /** Revision the caller read. */
  expectedRevision: number
  /** Read-only checks on the caller's authorization rows, committed with the delete. */
  authorizationConditionChecks?: readonly AuditTransactWriteItem[]
  /** Audit event written in the same transaction. */
  auditPut?: AuditTransactWriteItem
}

/** Persistence of the non-secret settings of channel destinations. */
export type ChannelDestinationStore = {
  /**
   * Strongly reads a destination's settings.
   * @param workspaceId - Canonical Workspace ID.
   * @param target - Team or Project.
   * @returns The settings, or undefined when none are saved.
   */
  get(workspaceId: string, target: ChannelDestinationTarget): Promise<ChannelDestinationRecord | undefined>
  /**
   * Strongly reads the revision a save must name, including that of a removed destination.
   * @param workspaceId - Canonical Workspace ID.
   * @param target - Team or Project.
   * @returns The stored revision, or 0 when the destination was never saved.
   */
  getRevision(workspaceId: string, target: ChannelDestinationTarget): Promise<number>
  /**
   * Saves the settings when the stored revision still matches.
   * @param input - Settings, expected revision, and transactional checks.
   * @returns The saved settings.
   * @throws NotificationError (409) when another save won.
   */
  save(input: SaveChannelDestinationInput): Promise<ChannelDestinationRecord>
  /**
   * Removes the settings when the stored revision still matches, keeping the next revision so a
   * later registration never reuses an earlier one.
   * @param input - Target, expected revision, and transactional checks.
   * @throws NotificationError (409) when the revision changed.
   */
  delete(input: DeleteChannelDestinationInput): Promise<void>
  /**
   * Writes the audit event of a change that has no settings row, such as the caller's own
   * Slack destination.
   * @param auditPut - Audit put without the webhook URL.
   */
  recordAudit(auditPut: AuditTransactWriteItem): Promise<void>
}

/** Contents of one post queued for a Team or Project channel. */
export type ChannelPostContent = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Audit event the post comes from; one post per event. */
  eventId: string
  /** Kind of event. */
  eventType: NotificationChannelPostEventType
  /** Destination chosen when the post was queued. */
  target: ChannelDestinationTarget
  /** Target title. */
  title?: string
  /** Canonical Work Item key, when the event is about a Work Item. */
  workItemKey?: string
  /** Stored English summary. */
  summary?: string
  /** Code and values of the summary, for the destination's language. */
  message?: NotificationMessage
  /** Relative in-app path of the target. */
  deepLink?: string
  /** When the event happened. */
  occurredAt: string
  /** Where the event's source sat when the post was queued, rechecked before sending. */
  source: ChannelPostSource
}

/** Identity of a post's source, enough to reread its current Team and Project. */
export type ChannelPostSource = {
  /** Team of the source when queued. */
  teamId: string
  /** Project of the source when queued, when it had one. */
  projectId?: string
  /** Work Item of a due or overdue event. */
  issueId?: string
  /** Due date a due or overdue event was scheduled for. */
  dueDate?: string
  /** Planning entity of a Milestone event. */
  entityId?: string
  /** Planning update target record of a health update event. */
  planningTargetRecordKey?: string
}

/** One queued post with its delivery state. */
export type ChannelPost = ChannelPostContent & {
  /** Queue partition of the post. */
  shard: string
  /** Claimed attempts so far. */
  attempts: number
  /** Row revision read before claiming. */
  version: number
  /** Next time the post may be tried. */
  nextAttemptAt: string
}

/** Durable queue of channel posts, fenced by leases like the personal Slack queue. */
export type ChannelPostStore = {
  /**
   * Queues a post once per event; a second call for the same event does nothing.
   * @param post - Post contents.
   * @param now - Queue time.
   */
  enqueue(post: ChannelPostContent, now: Date): Promise<void>
  /**
   * Lists due posts of one queue partition.
   * @param shard - Queue partition.
   * @param now - Current time.
   * @param limit - Most posts returned.
   * @returns Due posts and the number of unreadable candidates.
   */
  listDue(shard: string, now: Date, limit: number): Promise<{
    /** Valid due posts. */
    posts: ChannelPost[]
    /** Candidates that could not be read. */
    invalidCount: number
  }>
  /**
   * Claims a post for one attempt when its revision and due time are unchanged.
   * @param post - Post as read.
   * @param token - Lease token of this attempt.
   * @param leaseUntil - Lease end.
   * @returns False when another worker claimed it first.
   */
  claim(post: ChannelPost, token: string, leaseUntil: Date): Promise<boolean>
  /**
   * Extends the lease right before sending, only while this attempt still holds an unexpired lease
   * on the claimed revision, so a stalled attempt never sends after another one took over.
   * @param post - Claimed post, with the claimed revision.
   * @param token - Lease token of the claim.
   * @param now - Current time.
   * @returns False when the lease was lost or expired.
   */
  renew(post: ChannelPost, token: string, now: Date): Promise<boolean>
  /**
   * Records the outcome of a claimed attempt.
   * @param post - Claimed post.
   * @param token - Lease token of the claim.
   * @param status - Outcome.
   * @param nextAttemptAt - Retry time; required for `pending`.
   * @param code - Safe outcome code.
   */
  finish(
    post: ChannelPost,
    token: string,
    status: 'sent' | 'suppressed' | 'failed' | 'pending',
    nextAttemptAt?: Date,
    code?: string,
  ): Promise<void>
}
