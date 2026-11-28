import {
  isSlackTs,
  readSlackMessageContent,
  type SlackMessageContent,
} from '../domain/slack-events'
import {
  buildSlackPermalink,
  extractWorkItemKeys,
  messageExpiresAt,
  readSlackTeamOrigin,
  retentionCutoffTs,
} from '../domain/slack-message'
import { SlackIngestError, SlackRateLimitedError } from '../errors'
import type {
  SlackChannelRecord,
  SlackIngestConfigSource,
  SlackIngestJob,
  SlackIngestQueue,
  SlackIngestStore,
  SlackInstallation,
  SlackMessageWriteOutcome,
  SlackWebApi,
} from './ports/slack-ingest-ports'

/** Most messages and replies loaded for one mapping. */
export const SLACK_BACKFILL_MESSAGE_LIMIT = 2_000

/** Most replies loaded from one thread. */
export const SLACK_BACKFILL_REPLY_LIMIT = 200

/** Most stored messages one prune job deletes before queueing the rest. */
const PRUNE_BATCH_LIMIT = 1_000

/** Seconds a deletion tombstone is kept, longer than Slack redelivers an event. */
const TOMBSTONE_SECONDS = 15 * 86_400

/** Seconds an author name is cached. */
const USER_NAME_CACHE_SECONDS = 7 * 86_400

/** Milliseconds `auth.test` results are reused. */
const INSTALLATION_MAX_AGE_MS = 86_400_000

/** Longest delay SQS accepts on a message. */
const MAX_QUEUE_DELAY_SECONDS = 900

/** Ports of the worker. */
export type SlackIngestWorkerPorts = {
  /** Slack app settings. */
  config: SlackIngestConfigSource
  /** Ingest rows. */
  store: SlackIngestStore
  /** Worker queue, for follow-up pages and retries. */
  queue: SlackIngestQueue
  /**
   * Creates a Web API client with the bot token.
   *
   * @param botToken - Bot token.
   * @returns The client.
   */
  createSlackWebApi(botToken: string): SlackWebApi
  /**
   * Reports whether the Workspace still allows normal access (not closing or closed).
   *
   * @param workspaceId - Workspace ID.
   * @returns Whether ingest may change its data.
   */
  isWorkspaceActive(workspaceId: string): Promise<boolean>
  /**
   * Returns the current time.
   *
   * @returns Now.
   */
  now(): Date
}

/** Per-job state shared by its steps. */
type JobContext = {
  /** Workspace ID. */
  workspaceId: string
  /** Ports. */
  ports: SlackIngestWorkerPorts
  /** Slack client. */
  slack: SlackWebApi
  /** Now. */
  now: Date
  /** Lazily checked installation. */
  installation?: SlackInstallation
}

/**
 * Runs one ingest job. A Slack 429 queues the same job again after the delay Slack asked for.
 *
 * @param job - Job from the queue.
 * @param ports - Ports.
 * @returns What happened, for logs.
 * @throws Error for failures the queue should retry.
 */
export async function runSlackIngestJob(job: SlackIngestJob, ports: SlackIngestWorkerPorts): Promise<string> {
  // Deleting stored messages needs no Slack credentials, so it also runs after the app is removed.
  if (job.kind === 'prune') return await runPrune(ports, job, ports.now())
  const config = await ports.config.read()
  // The operator removed the app or tied it to another Workspace; queued work for this one ends.
  if (!config || config.workspaceId !== job.workspaceId) return 'not-configured'
  // A closing or closed Workspace takes no more ingest, including jobs queued before closure.
  if (!await ports.isWorkspaceActive(job.workspaceId)) return 'workspace-inactive'
  const context: JobContext = {
    workspaceId: job.workspaceId,
    ports,
    slack: ports.createSlackWebApi(config.botToken),
    now: ports.now(),
  }
  try {
    if (job.kind === 'event') return await applyEvent(context, job)
    return await runBackfillPage(context, job)
  } catch (error) {
    if (error instanceof SlackRateLimitedError) {
      await ports.queue.send(job, Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, error.retryAfterSeconds)))
      return 'rate-limited'
    }
    throw error
  }
}

/**
 * Reads the installation, calling `auth.test` when it is missing or a day old.
 *
 * @param context - Job context.
 * @returns The installation.
 * @throws SlackIngestError `unavailable` when Slack returns a team URL that is not Slack's.
 */
async function readInstallation(context: JobContext): Promise<SlackInstallation> {
  if (context.installation) return context.installation
  const stored = await context.ports.store.getInstallation(context.workspaceId)
  if (stored && context.now.getTime() - Date.parse(stored.checkedAt) < INSTALLATION_MAX_AGE_MS) {
    context.installation = stored
    return stored
  }
  const result = await context.slack.authTest()
  const teamOrigin = readSlackTeamOrigin(result.url)
  if (!teamOrigin) throw new SlackIngestError('unavailable', 'SlackTeamUrlInvalid', 'Slack returned an unexpected team URL.')
  const installation = { teamOrigin, botUserId: result.userId, checkedAt: context.now.toISOString() }
  await context.ports.store.putInstallation(context.workspaceId, installation)
  context.installation = installation
  return installation
}

/**
 * Reads an author's display name from the cache or Slack.
 *
 * @param context - Job context.
 * @param userId - Slack user ID.
 * @returns The name, when Slack has one.
 */
async function readAuthorName(context: JobContext, userId: string): Promise<string | undefined> {
  const cached = await context.ports.store.getUserName(context.workspaceId, userId)
  if (cached !== undefined) return cached ?? undefined
  const name = await context.slack.userName(userId)
  await context.ports.store.putUserName(
    context.workspaceId,
    userId,
    name,
    Math.floor(context.now.getTime() / 1000) + USER_NAME_CACHE_SECONDS,
  )
  return name ?? undefined
}

/**
 * Stores one message of a mapped channel when it is inside the retention period.
 *
 * @param context - Job context.
 * @param message - Normalized message.
 * @param retentionDays - Days messages are kept.
 * @param mappingRevision - Channel mapping revision the job read.
 * @returns The write outcome, or `expired` for a message past the retention.
 */
async function storeMessage(
  context: JobContext,
  message: SlackMessageContent,
  retentionDays: number,
  mappingRevision: number,
): Promise<SlackMessageWriteOutcome | 'expired'> {
  const nowSeconds = Math.floor(context.now.getTime() / 1000)
  if (message.ts < retentionCutoffTs(nowSeconds, retentionDays)) return 'expired'
  const installation = await readInstallation(context)
  const authorName = await readAuthorName(context, message.userId)
  const outcome = await context.ports.store.putMessage(context.workspaceId, {
    ...message,
    ...(authorName ? { authorName } : {}),
    keys: extractWorkItemKeys(message.text),
    permalink: buildSlackPermalink(installation.teamOrigin, message.channelId, message.ts, message.threadTs),
    expiresAt: messageExpiresAt(message.ts, retentionDays),
  }, mappingRevision)
  return outcome
}

/**
 * Records a channel the bot is in but has not seen yet, so that an administrator can map it.
 *
 * @param context - Job context.
 * @param channelId - Channel ID.
 * @returns The channel row.
 */
async function recordJoinedChannel(context: JobContext, channelId: string): Promise<SlackChannelRecord> {
  const info = await context.slack.conversationInfo(channelId)
  return await context.ports.store.recordMembership(context.workspaceId, {
    channelId,
    ...(info.name ? { name: info.name } : {}),
    isPrivate: info.isPrivate,
    membership: 'joined',
    now: context.now.toISOString(),
  })
}

/**
 * Starts loading a mapped channel's earlier messages.
 *
 * @param context - Job context.
 * @param channel - Mapped channel the bot is in.
 */
async function startBackfill(context: JobContext, channel: SlackChannelRecord): Promise<void> {
  await context.ports.store.updateBackfill(
    context.workspaceId,
    channel.channelId,
    channel.mappingRevision,
    { status: 'pending', importedCount: 0 },
    context.now.toISOString(),
  )
  await context.ports.queue.send({
    kind: 'backfill',
    workspaceId: context.workspaceId,
    channelId: channel.channelId,
    mappingRevision: channel.mappingRevision,
  })
}

/**
 * Applies one Slack event.
 *
 * @param context - Job context.
 * @param job - Event job.
 * @returns What happened.
 */
async function applyEvent(context: JobContext, job: Extract<SlackIngestJob, { kind: 'event' }>): Promise<string> {
  const { event } = job
  const { store } = context.ports
  if (event.kind === 'member-joined') {
    const installation = await readInstallation(context)
    if (event.userId !== installation.botUserId) return 'ignored-member'
    const channel = await recordJoinedChannel(context, event.channelId)
    if (channel.target) await startBackfill(context, channel)
    return 'bot-joined'
  }
  if (event.kind === 'bot-left') {
    const existing = await store.getChannel(context.workspaceId, event.channelId)
    await store.recordMembership(context.workspaceId, {
      channelId: event.channelId,
      ...(existing?.name ? { name: existing.name } : {}),
      isPrivate: existing?.isPrivate ?? false,
      membership: 'left',
      now: context.now.toISOString(),
    })
    return 'bot-left'
  }
  const channelId = event.kind === 'message-deleted' ? event.channelId : event.message.channelId
  const channel = await store.getChannel(context.workspaceId, channelId)
    ?? await recordJoinedChannel(context, channelId)
  if (!channel.target) return 'unmapped'
  if (event.kind === 'message-deleted') {
    await store.deleteMessage(
      context.workspaceId,
      { channelId, ts: event.ts },
      event.eventTs,
      Math.floor(context.now.getTime() / 1000) + TOMBSTONE_SECONDS,
    )
    return 'deleted'
  }
  const settings = await store.getSettings(context.workspaceId)
  const outcome = await storeMessage(context, event.message, settings.retentionDays, channel.mappingRevision)
  return outcome === 'written' ? 'stored' : 'skipped'
}

/**
 * Loads one history page of a mapped channel, with the replies of its threads, and queues the next.
 *
 * @param context - Job context.
 * @param job - Backfill job.
 * @returns What happened.
 */
async function runBackfillPage(context: JobContext, job: Extract<SlackIngestJob, { kind: 'backfill' }>): Promise<string> {
  const { store } = context.ports
  const channel = await store.getChannel(context.workspaceId, job.channelId)
  if (!channel?.target || channel.mappingRevision !== job.mappingRevision) return 'superseded'
  const nowIso = context.now.toISOString()
  if (channel.membership !== 'joined') {
    await store.updateBackfill(context.workspaceId, job.channelId, job.mappingRevision, {
      status: 'failed',
      importedCount: channel.backfill?.importedCount ?? 0,
    }, nowIso)
    return 'not-member'
  }
  const settings = await store.getSettings(context.workspaceId)
  const oldest = retentionCutoffTs(Math.floor(context.now.getTime() / 1000), settings.retentionDays)
  const previous = channel.backfill?.importedCount ?? 0
  let imported = 0
  let loadedBeforeTs = job.resumeBeforeTs
  const page = await context.slack.history(job.channelId, oldest, job.cursor)
  try {
    for (const raw of page.messages) {
      if (previous + imported >= SLACK_BACKFILL_MESSAGE_LIMIT) break
      const rawTs = readRawTs(raw)
      // History lists newest first, so a resumed page skips what the earlier attempt loaded.
      if (rawTs && job.resumeBeforeTs && rawTs >= job.resumeBeforeTs) continue
      const message = readSlackMessageContent(job.channelId, raw)
      if (message) {
        const outcome = await storeMessage(context, message, settings.retentionDays, job.mappingRevision)
        if (outcome === 'unmapped') return 'superseded'
        if (outcome === 'written') imported += 1
      }
      const parentTs = readThreadParentTs(raw)
      if (parentTs) {
        const replies = await context.slack.replies(job.channelId, parentTs, oldest)
        let threadCount = 0
        for (const rawReply of replies.messages) {
          if (threadCount >= SLACK_BACKFILL_REPLY_LIMIT || previous + imported >= SLACK_BACKFILL_MESSAGE_LIMIT) break
          const reply = readSlackMessageContent(job.channelId, rawReply)
          if (!reply?.threadTs) continue
          threadCount += 1
          const outcome = await storeMessage(context, reply, settings.retentionDays, job.mappingRevision)
          if (outcome === 'unmapped') return 'superseded'
          if (outcome === 'written') imported += 1
        }
      }
      if (rawTs) loadedBeforeTs = rawTs
    }
  } catch (error) {
    if (!(error instanceof SlackRateLimitedError)) throw error
    // Keep what this attempt loaded and retry the same page from the first unfinished message.
    const current = await store.updateBackfill(context.workspaceId, job.channelId, job.mappingRevision, {
      status: 'running',
      importedCount: previous + imported,
    }, nowIso)
    if (!current) return 'superseded'
    await context.ports.queue.send(
      { ...job, ...(loadedBeforeTs ? { resumeBeforeTs: loadedBeforeTs } : {}) },
      Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, error.retryAfterSeconds)),
    )
    return 'rate-limited'
  }
  const total = previous + imported
  const more = page.nextCursor !== undefined && total < SLACK_BACKFILL_MESSAGE_LIMIT
  const current = await store.updateBackfill(context.workspaceId, job.channelId, job.mappingRevision, {
    status: more ? 'running' : 'completed',
    importedCount: total,
  }, nowIso)
  if (current && more && page.nextCursor) {
    await context.ports.queue.send({
      kind: 'backfill',
      workspaceId: job.workspaceId,
      channelId: job.channelId,
      mappingRevision: job.mappingRevision,
      cursor: page.nextCursor,
    })
  }
  return more ? 'page-loaded' : 'completed'
}

/**
 * Reads the `ts` of a raw history message.
 *
 * @param raw - Raw Slack message.
 * @returns The `ts`, when valid.
 */
function readRawTs(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const ts = Reflect.get(raw, 'ts')
  return isSlackTs(ts) ? ts : undefined
}

/**
 * Reads the parent timestamp of a history message that has replies.
 *
 * @param raw - Raw history message.
 * @returns The thread timestamp, when the message starts a thread with replies.
 */
function readThreadParentTs(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const replyCount = Reflect.get(raw, 'reply_count')
  const threadTs = Reflect.get(raw, 'thread_ts')
  const ts = Reflect.get(raw, 'ts')
  if (typeof replyCount !== 'number' || replyCount < 1 || !isSlackTs(threadTs) || threadTs !== ts) return undefined
  return threadTs
}

/**
 * Deletes a channel's stored messages after an unmapping, or those out of retention.
 *
 * @param ports - Worker ports.
 * @param job - Prune job.
 * @param now - Current time.
 * @returns What happened.
 */
async function runPrune(
  ports: SlackIngestWorkerPorts,
  job: Extract<SlackIngestJob, { kind: 'prune' }>,
  now: Date,
): Promise<string> {
  const { store } = ports
  const channel = await store.getChannel(job.workspaceId, job.channelId)
  let beforeTs: string | undefined
  let retentionDays: number | undefined
  if (job.mode === 'all') {
    // A newer mapping keeps the messages it loads.
    if (channel?.target && channel.mappingRevision !== job.mappingRevision) return 'superseded'
  } else {
    if (!channel?.target) return 'unmapped'
    const settings = await store.getSettings(job.workspaceId)
    retentionDays = settings.retentionDays
    beforeTs = retentionCutoffTs(Math.floor(now.getTime() / 1000), settings.retentionDays)
  }
  if (job.afterTs !== undefined && retentionDays !== undefined) {
    return await shortenExpiry(ports, job, job.afterTs, retentionDays)
  }
  const result = await store.deleteChannelMessages(
    job.workspaceId,
    job.channelId,
    beforeTs,
    PRUNE_BATCH_LIMIT,
    job.mappingRevision,
  )
  if (result.superseded) return 'superseded'
  if (!result.done) {
    await ports.queue.send(job)
    return 'prune-continues'
  }
  // The messages that stay still carry the expiry of the longer retention; shorten it too.
  if (retentionDays !== undefined) return await shortenExpiry(ports, job, undefined, retentionDays)
  return 'pruned'
}

/**
 * Shortens the expiry of a channel's remaining messages to the current retention, one page per
 * job.
 *
 * @param ports - Worker ports.
 * @param job - Expired prune job.
 * @param afterTs - Continues after this message, when given.
 * @param retentionDays - Days messages are kept.
 * @returns What happened, for logs.
 */
async function shortenExpiry(
  ports: SlackIngestWorkerPorts,
  job: Extract<SlackIngestJob, { kind: 'prune' }>,
  afterTs: string | undefined,
  retentionDays: number,
): Promise<string> {
  const { next } = await ports.store.shortenChannelExpiry(job.workspaceId, job.channelId, afterTs, retentionDays, PRUNE_BATCH_LIMIT)
  if (!next) return 'pruned'
  await ports.queue.send({ ...job, afterTs: next })
  return 'prune-continues'
}
