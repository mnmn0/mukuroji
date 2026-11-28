import { isSlackChannelId } from '@mukuroji/contracts'
import { isSlackTs, isSlackUserId, readSlackMessageContent, type SlackInboundEvent } from '../../domain/slack-events'
import type { SlackIngestJob } from '../../application/ports/slack-ingest-ports'
import { runSlackIngestJob, type SlackIngestWorkerPorts } from '../../application/slack-ingest-worker'

/** One SQS record of the Slack ingest queue. */
export type SlackIngestSqsRecord = {
  /** SQS message ID. */
  messageId?: string
  /** JSON job. */
  body?: string
}

/** SQS Lambda event of the Slack ingest queue. */
export type SlackIngestSqsEvent = {
  /** Records of the batch. */
  Records?: SlackIngestSqsRecord[]
}

/** Partial batch response. */
export type SlackIngestBatchResponse = {
  /** Messages to retry. */
  batchItemFailures: { itemIdentifier: string }[]
}

/** Workspace ID shape. */
const WORKSPACE_ID_PATTERN = /^[\x21-\x7e]{1,256}$/u

/**
 * Reports whether a value is an object that is not an array.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuilds a queued event from its JSON, accepting only the normalized shapes.
 *
 * @param value - Queued event.
 * @returns The event.
 * @throws TypeError when the value is not a normalized event.
 */
function parseQueuedEvent(value: unknown): SlackInboundEvent {
  if (!isRecord(value)) throw new TypeError('event is invalid.')
  const channelKind = value.channelKind === 'public' || value.channelKind === 'private' ? value.channelKind : undefined
  if (value.kind === 'message-posted' || value.kind === 'message-changed') {
    const raw = value.message
    if (!isRecord(raw) || !isSlackChannelId(raw.channelId) || !channelKind) throw new TypeError('message is invalid.')
    const message = readSlackMessageContent(raw.channelId, {
      ts: raw.ts,
      user: raw.userId,
      text: raw.text,
      ...(raw.threadTs === undefined ? {} : { thread_ts: raw.threadTs }),
      ...(raw.editedTs === undefined ? {} : { edited: { ts: raw.editedTs } }),
    })
    if (!message) throw new TypeError('message is invalid.')
    return { kind: value.kind, channelKind, message }
  }
  if (value.kind === 'message-deleted') {
    if (!isSlackChannelId(value.channelId) || !isSlackTs(value.ts) || !isSlackTs(value.eventTs)) {
      throw new TypeError('deletion is invalid.')
    }
    return { kind: 'message-deleted', channelId: value.channelId, ts: value.ts, eventTs: value.eventTs }
  }
  if (value.kind === 'member-joined') {
    if (!isSlackChannelId(value.channelId) || !isSlackUserId(value.userId)) throw new TypeError('join is invalid.')
    return { kind: 'member-joined', channelId: value.channelId, userId: value.userId, ...(channelKind ? { channelKind } : {}) }
  }
  if (value.kind === 'bot-left') {
    if (!isSlackChannelId(value.channelId)) throw new TypeError('leave is invalid.')
    return { kind: 'bot-left', channelId: value.channelId }
  }
  throw new TypeError('event kind is invalid.')
}

/**
 * Parses one queued job.
 *
 * @param body - SQS message body.
 * @returns The job.
 * @throws TypeError when the body is not a job.
 */
export function parseSlackIngestJob(body: string | undefined): SlackIngestJob {
  const value: unknown = JSON.parse(body ?? '')
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(value.workspaceId)) {
    throw new TypeError('job is invalid.')
  }
  const workspaceId = value.workspaceId
  if (value.kind === 'event') {
    if (typeof value.eventId !== 'string' || value.eventId.length > 64) throw new TypeError('eventId is invalid.')
    return { kind: 'event', workspaceId, eventId: value.eventId, event: parseQueuedEvent(value.event) }
  }
  if (!isSlackChannelId(value.channelId) || typeof value.mappingRevision !== 'number' || !Number.isSafeInteger(value.mappingRevision)) {
    throw new TypeError('job channel is invalid.')
  }
  if (value.kind === 'backfill') {
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 512)) {
      throw new TypeError('cursor is invalid.')
    }
    if (value.resumeBeforeTs !== undefined && !isSlackTs(value.resumeBeforeTs)) {
      throw new TypeError('resumeBeforeTs is invalid.')
    }
    return {
      kind: 'backfill',
      workspaceId,
      channelId: value.channelId,
      mappingRevision: value.mappingRevision,
      ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
      ...(isSlackTs(value.resumeBeforeTs) ? { resumeBeforeTs: value.resumeBeforeTs } : {}),
    }
  }
  if (value.kind === 'prune' && (value.mode === 'all' || value.mode === 'expired')) {
    return { kind: 'prune', workspaceId, channelId: value.channelId, mode: value.mode, mappingRevision: value.mappingRevision }
  }
  throw new TypeError('job kind is invalid.')
}

/**
 * Processes one SQS batch, retrying only the records that failed. A malformed record fails and
 * reaches the dead-letter queue after the queue's receive limit.
 *
 * @param event - SQS batch.
 * @param ports - Worker ports.
 * @returns Records to retry.
 */
export async function processSlackIngestBatch(
  event: SlackIngestSqsEvent,
  ports: SlackIngestWorkerPorts,
): Promise<SlackIngestBatchResponse> {
  const failures: { itemIdentifier: string }[] = []
  for (const record of event.Records ?? []) {
    try {
      const job = parseSlackIngestJob(record.body)
      const outcome = await runSlackIngestJob(job, ports)
      console.info('Slack ingest job finished.', { kind: job.kind, outcome })
    } catch (error) {
      console.error('Slack ingest job failed.', {
        messageId: record.messageId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'unknown',
      })
      failures.push({ itemIdentifier: record.messageId ?? '' })
    }
  }
  return { batchItemFailures: failures }
}
