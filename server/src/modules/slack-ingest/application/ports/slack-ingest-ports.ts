import type { SlackChannelBackfillStatus, SlackChannelTarget } from '@mukuroji/contracts'
import type { SlackInboundEvent, SlackMessageContent } from '../../domain/slack-events'

/** Deployment settings of the Slack app, read from the operator's secret. */
export type SlackIngestConfig = {
  /** Slack app signing secret. */
  signingSecret: string
  /** Bot token (`xoxb-`). */
  botToken: string
  /** Slack team the app is installed in. */
  teamId: string
  /** Slack app ID; events from another app are refused when set. */
  appId?: string
  /** Mukuroji Workspace the Slack team is tied to. */
  workspaceId: string
}

/** Reads the Slack app settings. */
export interface SlackIngestConfigSource {
  /**
   * Reads the current settings.
   *
   * @returns The settings, or `undefined` when this deployment has no Slack app.
   */
  read(): Promise<SlackIngestConfig | undefined>
}

/** One asynchronous ingest step. */
export type SlackIngestJob =
  | {
      /** Apply one Slack event. */
      kind: 'event'
      /** Workspace ID. */
      workspaceId: string
      /** Slack event ID, for logs. */
      eventId: string
      /** Normalized event. */
      event: SlackInboundEvent
    }
  | {
      /** Load one page of a mapped channel's earlier messages. */
      kind: 'backfill'
      /** Workspace ID. */
      workspaceId: string
      /** Channel ID. */
      channelId: string
      /** Mapping revision the load belongs to; a newer mapping stops it. */
      mappingRevision: number
      /** Slack history cursor of the page. */
      cursor?: string
      /**
       * Messages of the page at or after this `ts` were already loaded, so a retry after a rate
       * limit resumes where it stopped.
       */
      resumeBeforeTs?: string
    }
  | {
      /** Delete stored messages of a channel. */
      kind: 'prune'
      /** Workspace ID. */
      workspaceId: string
      /** Channel ID. */
      channelId: string
      /** `all` after an unmapping; `expired` after the retention got shorter. */
      mode: 'all' | 'expired'
      /** Mapping revision that asked for the deletion; a later mapping stops an `all` prune. */
      mappingRevision: number
      /** For `expired`, messages up to this `ts` already have the shorter expiry. */
      afterTs?: string
    }

/** Sends ingest jobs to the worker queue. */
export interface SlackIngestQueue {
  /**
   * Queues one job.
   *
   * @param job - Job to run.
   * @param delaySeconds - Seconds before the worker may receive it, up to 900.
   */
  send(job: SlackIngestJob, delaySeconds?: number): Promise<void>
}

/** Workspace-level ingest settings. */
export type SlackIngestSettings = {
  /** Days messages are kept. */
  retentionDays: number
  /** Revision, 0 before the first save. */
  revision: number
}

/** What the worker learned from `auth.test`. */
export type SlackInstallation = {
  /** Team origin such as `https://example.slack.com`. */
  teamOrigin: string
  /** Bot user ID. */
  botUserId: string
  /** ISO 8601 time it was checked. */
  checkedAt: string
}

/** Stored state of one channel. */
export type SlackChannelRecord = {
  /** Channel ID. */
  channelId: string
  /** Channel name, when known. */
  name?: string
  /** Whether the channel is private. */
  isPrivate: boolean
  /** Whether the bot is a member. */
  membership: 'joined' | 'left'
  /** Mapping target; unmapped channels are not stored. */
  target?: SlackChannelTarget
  /** Revision of the mapping, starting at 0 before the first mapping. */
  mappingRevision: number
  /** Earlier-message load of the current mapping. */
  backfill?: {
    /** Load state. */
    status: SlackChannelBackfillStatus
    /** Messages and replies loaded so far. */
    importedCount: number
  }
  /** ISO 8601 time the row last changed. */
  updatedAt: string
}

/** One stored message. */
export type StoredSlackMessage = SlackMessageContent & {
  /** Author display name, when known. */
  authorName?: string
  /** Work Item keys written in the text. */
  keys: string[]
  /** Link that opens the message in Slack. */
  permalink: string
  /** Unix seconds after which DynamoDB deletes the row. */
  expiresAt: number
}

/** Reference to one stored message. */
export type SlackMessageRef = {
  /** Channel ID. */
  channelId: string
  /** Message timestamp. */
  ts: string
}

/** Audit details of an administrator's change, recorded with the change. */
export type SlackIngestAuditInput<AuditContext> = {
  /** Request audit context. */
  context: AuditContext
  /** ISO 8601 time of the change. */
  now: string
}

/** Outcome of a conditional message write. */
export type SlackMessageWriteOutcome = 'written' | 'stale' | 'unmapped'

/** Persistence of the Slack ingest rows. */
export interface SlackIngestStore<AuditContext = unknown> {
  /**
   * Reads the Workspace settings.
   *
   * @param workspaceId - Workspace ID.
   * @returns The settings, or the defaults when none were saved.
   */
  getSettings(workspaceId: string): Promise<SlackIngestSettings>
  /**
   * Saves the retention while the revision is still the one read.
   *
   * @param workspaceId - Workspace ID.
   * @param retentionDays - New retention.
   * @param expectedRevision - Revision read by the caller.
   * @param audit - Audit context of the change.
   * @returns The saved settings.
   * @throws SlackIngestError `conflict` when the revision changed.
   */
  saveSettings(
    workspaceId: string,
    retentionDays: number,
    expectedRevision: number,
    audit: SlackIngestAuditInput<AuditContext>,
  ): Promise<SlackIngestSettings>
  /**
   * Reads what `auth.test` returned last.
   *
   * @param workspaceId - Workspace ID.
   * @returns The installation, when checked before.
   */
  getInstallation(workspaceId: string): Promise<SlackInstallation | undefined>
  /**
   * Saves what `auth.test` returned.
   *
   * @param workspaceId - Workspace ID.
   * @param installation - Installation.
   */
  putInstallation(workspaceId: string, installation: SlackInstallation): Promise<void>
  /**
   * Reads one channel.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @returns The channel, when the bot has seen it.
   */
  getChannel(workspaceId: string, channelId: string): Promise<SlackChannelRecord | undefined>
  /**
   * Lists every channel the bot has seen.
   *
   * @param workspaceId - Workspace ID.
   * @returns Channels in channel ID order.
   */
  listChannels(workspaceId: string): Promise<SlackChannelRecord[]>
  /**
   * Records that the bot joined or left a channel, keeping its mapping.
   *
   * @param workspaceId - Workspace ID.
   * @param channel - Channel facts from Slack.
   * @returns The channel after the change.
   */
  recordMembership(
    workspaceId: string,
    channel: { channelId: string, name?: string, isPrivate: boolean, membership: 'joined' | 'left', now: string },
  ): Promise<SlackChannelRecord>
  /**
   * Changes a channel's mapping while its revision is still the one read, and resets its load.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param target - New target, or `undefined` to unmap.
   * @param expectedRevision - Mapping revision read by the caller.
   * @param audit - Audit context of the change.
   * @returns The channel after the change.
   * @throws SlackIngestError `conflict` when the mapping changed, `not-found` when the channel is unknown.
   */
  setChannelTarget(
    workspaceId: string,
    channelId: string,
    target: SlackChannelTarget | undefined,
    expectedRevision: number,
    audit: SlackIngestAuditInput<AuditContext>,
  ): Promise<SlackChannelRecord>
  /**
   * Updates the earlier-message load of a mapping that is still current.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param mappingRevision - Mapping the load belongs to.
   * @param backfill - New load state.
   * @param now - ISO 8601 time.
   * @returns Whether the mapping was still current.
   */
  updateBackfill(
    workspaceId: string,
    channelId: string,
    mappingRevision: number,
    backfill: NonNullable<SlackChannelRecord['backfill']>,
    now: string,
  ): Promise<boolean>
  /**
   * Writes a message unless a newer version or a deletion is stored, and replaces its key rows.
   * The write is conditional on the channel still being mapped at the revision read, so a job
   * that outlives an unmap or a remap cannot bring deleted messages back.
   *
   * @param workspaceId - Workspace ID.
   * @param message - Message to store.
   * @param mappingRevision - Channel mapping revision the job read.
   * @returns `stale` when a newer version or a deletion won, `unmapped` when the mapping changed.
   */
  putMessage(workspaceId: string, message: StoredSlackMessage, mappingRevision: number): Promise<SlackMessageWriteOutcome>
  /**
   * Replaces a message with a short-lived tombstone and deletes its key rows.
   *
   * @param workspaceId - Workspace ID.
   * @param ref - Message.
   * @param eventTs - Deletion timestamp, stored as the tombstone's version.
   * @param expiresAt - Unix seconds the tombstone is kept until.
   */
  deleteMessage(workspaceId: string, ref: SlackMessageRef, eventTs: string, expiresAt: number): Promise<void>
  /**
   * Reads stored messages, leaving out tombstones and missing rows.
   *
   * @param workspaceId - Workspace ID.
   * @param refs - Messages to read.
   * @returns The messages that exist.
   */
  getMessages(workspaceId: string, refs: readonly SlackMessageRef[]): Promise<StoredSlackMessage[]>
  /**
   * Lists the messages that mention a Work Item key.
   *
   * @param workspaceId - Workspace ID.
   * @param key - Canonical Work Item key.
   * @param limit - Most references to return.
   * @returns References and whether more exist.
   */
  listMessageRefsByKey(
    workspaceId: string,
    key: string,
    limit: number,
  ): Promise<{ refs: SlackMessageRef[], truncated: boolean }>
  /**
   * Deletes up to `limit` stored messages of a channel and their key rows. Every delete is
   * conditional on the channel's mapping revision, so a cleanup job cannot delete messages that
   * a newer mapping loaded.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param beforeTs - Deletes only messages older than this timestamp, when given.
   * @param limit - Most messages to delete in this call.
   * @param mappingRevision - Channel mapping revision the cleanup belongs to.
   * @returns How many were deleted, whether none remain, and whether the mapping changed.
   */
  deleteChannelMessages(
    workspaceId: string,
    channelId: string,
    beforeTs: string | undefined,
    limit: number,
    mappingRevision: number,
  ): Promise<{ deleted: number, done: boolean, superseded?: true }>
  /**
   * Shortens the expiry of a channel's remaining messages and their key rows to the retention,
   * so a shorter retention also bounds how long messages newer than its cutoff stay stored.
   *
   * @param workspaceId - Workspace ID.
   * @param channelId - Channel ID.
   * @param afterTs - Continues after this message, when given.
   * @param retentionDays - Days messages are kept.
   * @param limit - Most messages to read in this call.
   * @returns The `ts` to continue after, or nothing when every message was visited.
   */
  shortenChannelExpiry(
    workspaceId: string,
    channelId: string,
    afterTs: string | undefined,
    retentionDays: number,
    limit: number,
  ): Promise<{ next?: string }>
  /**
   * Reads a cached author display name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - Slack user ID.
   * @returns The name, or `null` when Slack had none, or `undefined` when not cached.
   */
  getUserName(workspaceId: string, userId: string): Promise<string | null | undefined>
  /**
   * Caches an author display name.
   *
   * @param workspaceId - Workspace ID.
   * @param userId - Slack user ID.
   * @param name - Name, or `null` when Slack had none.
   * @param expiresAt - Unix seconds the cache is kept until.
   */
  putUserName(workspaceId: string, userId: string, name: string | null, expiresAt: number): Promise<void>
}

/** One page of a channel's history. */
export type SlackHistoryPage = {
  /** Raw Slack message objects, validated by the caller. */
  messages: unknown[]
  /** Cursor of the next page. */
  nextCursor?: string
}

/** Slack Web API calls the worker makes with the bot token. */
export interface SlackWebApi {
  /**
   * Calls `auth.test`.
   *
   * @returns Team URL and bot user ID.
   */
  authTest(): Promise<{ url: string, userId: string }>
  /**
   * Calls `conversations.info`.
   *
   * @param channelId - Channel ID.
   * @returns Name and privacy.
   */
  conversationInfo(channelId: string): Promise<{ name?: string, isPrivate: boolean }>
  /**
   * Calls `conversations.history`.
   *
   * @param channelId - Channel ID.
   * @param oldest - Oldest timestamp to include.
   * @param cursor - Page cursor.
   * @returns One page.
   */
  history(channelId: string, oldest: string, cursor?: string): Promise<SlackHistoryPage>
  /**
   * Calls `conversations.replies` for one page of a thread.
   *
   * @param channelId - Channel ID.
   * @param threadTs - Parent timestamp.
   * @param oldest - Oldest timestamp to include.
   * @returns One page; the parent is included.
   */
  replies(channelId: string, threadTs: string, oldest: string): Promise<SlackHistoryPage>
  /**
   * Calls `users.info`.
   *
   * @param userId - User ID.
   * @returns Display name, or `null` when the user has none.
   */
  userName(userId: string): Promise<string | null>
}
